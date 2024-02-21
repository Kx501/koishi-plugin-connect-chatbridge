import { Command, Context, Schema, Session, Logger } from 'koishi';
import * as WebSocket from 'ws';
import axios from 'axios';

export const name = 'connect-chatbridge';

export const usage = `
短网址服务采用: https://www.urlc.cn/

修改后的Chatbridge见: https://github.com/Kxy051/ChatBridge
`

interface ConfigType {
  enable: boolean;
  port: number;
  token: string;
  收发消息的频道: string;
  机器人账号: string;
  指令转发QQ消息: boolean;
  频道内触发指令?: string;
  指令转发MC消息: boolean;
  游戏内触发指令?: string;
  urlAppId: string;
  urlAppSecret: string;
  使用被动方式转发: boolean;
  等待触发时长: number;
  使用备用频道: boolean;
  备用转发频道: string;
  启用定时任务: boolean;
  定时关闭转发频道消息: any;
  定时启动转发频道消息: any;
}

export const Config: Schema<ConfigType> = Schema.intersect([
  Schema.object({
    enable: Schema.boolean().default(false).description('是否开启 WebSocket 转发。'),
    port: Schema.number().default(5555).description('WebSocket 端口。'),
    token: Schema.string().role('secret').description('建立 WebSocket 连接的 token。')
  }).description('WebSocket 相关设置'),
  Schema.object({
    收发消息的频道: Schema.string().description('转发消息的子频道号。').required(),
    机器人账号: Schema.string().description('机器人子频道 id。').required(),
    指令转发QQ消息: Schema.boolean().default(false).description('是否指令触发。'),
    频道内触发指令: Schema.string().default('mc').description('QQ 内发送消息到 Minecraft 的指令，如有前缀请加上。'),
    指令转发MC消息: Schema.boolean().default(false).description('是否指令触发。'),
    游戏内触发指令: Schema.string().default('qq').description('Minecraft 内发送消息到 QQ 的指令，如有前缀请加上。')
  }).description('消息相关设置'),
  Schema.object({
    urlAppId: Schema.string().role('secret').description('短链接服务的 id。').deprecated(),
    urlAppSecret: Schema.string().role('secret').description('短链接服务的密钥，api 只有一个参数时填这里。').required()
  }).description('短链接服务相关设置'),
  Schema.object({
    使用被动方式转发: Schema.boolean().default(false).description('当频道内有人发言时转发消息，配合触发时长使用。').experimental(),
    等待触发时长: Schema.number().default(2000).description('(毫秒) 时间段内可触发被动发送，超时采用主动发送。<br>启用后转发消息到 QQ 会有延迟，效果自行测试。').experimental(),
    使用备用频道: Schema.boolean().default(false).description('如果采用主动消息转发，在单个频道推送上限后向备用频道推送。').experimental(),
    备用转发频道: Schema.string().description('备用频道号').experimental(),
    启用定时任务: Schema.boolean().default(false).description('凌晨有一段时间无法推送。').experimental(),
    定时关闭转发频道消息: Schema.tuple([Number, Number]).default([0, 0]).description('(24小时制) 设置时，分。').experimental(),
    定时启动转发频道消息: Schema.tuple([Number, Number]).default([6, 0]).description('(24小时制) 设置时，分。').experimental()
  }).description('其他设置')
])

export function apply(ctx: Context, config: ConfigType) {
  let server = null,
    bot = null,
    messageQueue = [],
    sessionFlag = false,
    triggerSuccess = false,
    max = false,
    max_ = false,
    hasExecuted = false,
    errorCount = 0;
  const logger = new Logger('connect-chatbridge');
  const tempChannel = config.收发消息的频道;

  ctx.on('dispose', () => {
    closeServer();
    logger.info('WebSocket 服务已关闭。');
  });

  ctx.on('ready', () => {
    if (server) {
      closeServer();
      logger.info('已关闭未正确关闭的 WebSocket 服务。');
    }
    if (config.enable) {
      logger.debug('调试模式开启！');
      if (config.启用定时任务) {
        scheduleTasks();
      }
      bot = ctx.bots[`qqguild:${config.机器人账号}`];
      startServer();
      logger.success('WebSocket 服务已启动。');
    }
  });

  ctx.middleware(async (session, next) => {
    if (server && server.clients.size > 0 && session.event._data.d.channel_id === config.收发消息的频道) {
      if (config.使用被动方式转发 && sessionFlag && !triggerSuccess) {
        triggerSuccess = true;
        logger.debug(`将被动发送消息队列: ${messageQueue}`);
        while (messageQueue.length > 0) {
          // 超时不需要中断
          await session.send(messageQueue[0]);
          messageQueue.shift();
        }
        triggerSuccess = false;
        logger.debug('被动方式转发成功');
      }
      const messageData = await processMessage(session.event);
      const messagePacket = createMessagePacket(session.event.user.name, messageData);

      if (!config.指令转发QQ消息 || session.elements[0].attrs.content.split(' ')[0] === config.频道内触发指令) {
        sendMessageToClients(messagePacket);
      }
    } else {
      return next();
    }
  });

  async function processMessage(sessionEvent: any) {
    let attrsTemp = '';

    for (let i = 0; i < sessionEvent.message.elements.length; i++) {
      attrsTemp += await processElement(sessionEvent.message.elements[i]);
    }

    if (config.指令转发QQ消息) {
      attrsTemp = attrsTemp.slice(attrsTemp.indexOf(' ') + 1);
    }

    return attrsTemp;
  }

  async function processElement(element: any) {
    let innerAttrsTemp = '';

    if (element.type.includes('emoji')) {
      innerAttrsTemp += ` /${element.type} `;
      if (element.children.length > 0) {
        for (let j = 0; j < element.children.length; j++) {
          innerAttrsTemp += await processElement(element.children[j]);
        }
      }
    } else if (element.type === 'img') {
      innerAttrsTemp += ` [表情/图片] ${await generateShortUrl(element.attrs.src)}`;
    } else if (element.type === 'text') {
      const content = element.attrs.content;
      const linkPattern = /\b(?:https?):\/\/\S+\b|\bwww\.\S+\b|\[link\]\((https?|www)\:\/\/\S+\)|\S+\.(html|jpg|png|gif|mp3|mp4)\b/g;
      let links = content.match(linkPattern);

      if (links) {
        for (let link of links) {
          const shortUrl = await generateShortUrl(link);
          element.attrs.content = element.attrs.content.replace(link, ` [链接] ${shortUrl} `);
        }
      }

      innerAttrsTemp += element.attrs.content;
    }

    return innerAttrsTemp;
  }

  async function generateShortUrl(originalUrl: string) {
    try {
      const formattedTomorrow = new Date(new Date().setDate(new Date().getDate() + 1)).toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });

      const requestData = { url: originalUrl, expiry: formattedTomorrow };
      const headers = { 'Authorization': 'Token ' + config.urlAppSecret, 'Content-Type': 'application/json' };
      const response = await axios.post('https://www.urlc.cn/api/url/add', requestData, { headers });
      const { error, short, msg } = response.data;

      if (error === 0) {
        return short;
      } else {
        throw new Error(`Error: ${msg}`);
      }
    } catch (error) {
      throw new Error(`Error in generateShortUrl: ${error}`);
    }
  }

  function startServer() {
    server = new WebSocket.Server({ port: config.port });
    server.on('connection', (socket: any, req: any) => {
      const wsUrl = new URL(req.url, `http://${req.headers.host}`);
      const accessToken = wsUrl.searchParams.get('access_token');

      if (config.token === accessToken) {
        logger.info('Token 验证通过，连接成功。');

        socket.addEventListener('message', (event: WebSocket.MessageEvent) => {
          const receivedData = event.data;

          if (typeof receivedData === 'string') {
            logger.debug(`接收到MC消息: ${receivedData}`);
            const sendMessage = JSON.parse(receivedData).message;
            processWebSocketMessage(sendMessage);
          } else if (receivedData instanceof ArrayBuffer) {
            logger.warn('接收到二进制数据，暂无处理逻辑！');
            // 如果需要处理二进制数据，请在此添加相应逻辑
            return;
          }
        });

        socket.addEventListener('close', (event: any) => {
          if (event.code === 1000) {
            logger.info('客户端关闭连接。');
          }
          else if (event.code !== 1006) {
            logger.warn(`连接关闭，关闭代码: ${event.code}，原因: ${event.reason}`);
          }
        });
      } else {
        socket.close();
        logger.warn('无效的 Token，连接已终止。');
        return;
      }
    });
  }

  function closeServer() {
    if (server) {
      if (server.clients.size > 0) {
        const client = server.clients.values().next().value;
        client.terminate()
      }
      server.close();
    }
  }

  async function scheduleTasks() {
    const now = new Date();
    logger.debug(`当前时间：${now}`);
    const startTime = new Date(now);
    startTime.setHours(config.定时启动转发频道消息[0], config.定时启动转发频道消息[1], 0, 0);
    logger.debug(`自动启动时间：${startTime}`);
    const stopTime = new Date(now);
    stopTime.setHours(config.定时关闭转发频道消息[0], config.定时关闭转发频道消息[1], 0, 0);
    logger.debug(`自动关闭时间：${stopTime}`);

    if (now >= stopTime && now <= startTime) {
      const timeUntilNextStart = startTime.getTime() - now.getTime();
      logger.debug(`距下一次启动还剩：${timeUntilNextStart} ms。`);
      setTimeout(() => {
        max = false;
        max_ = false;
        logger.info("定时启动转发！");
        errorCount = 0;
        scheduleTasks();
      }, timeUntilNextStart);
    } else {
      const timeUntilNextStop = stopTime.setDate(stopTime.getDate() + 1) - now.getTime();
      logger.debug(`距下一次关闭还剩：${timeUntilNextStop} ms。`);
      setTimeout(() => {
        max = true;
        max_ = true;
        logger.info("定时关闭转发！");
        scheduleTasks();
      }, timeUntilNextStop);
    }
  }

  function createMessagePacket(sessionUser: string, messageData: string) {
    return JSON.stringify({
      sender: sessionUser,
      message: `${messageData}`
    });
  }

  function sendMessageToClients(messagePacket: string) {
    const client = server.clients.values().next().value;
    logger.debug(`将转发QQ消息: ${messagePacket}`)
    client.send(messagePacket);
    logger.debug('QQ消息转发成功！');
  }

  async function processWebSocketMessage(sendMessage: string) {
    try {
      if (max && max_) {
        if (!hasExecuted) {
          const endPacket = JSON.stringify({
            sender: 'Koshi',
            message: '今日消息推送受限，不再向频道转发消息！'
          })
          sendMessageToClients(endPacket);
          hasExecuted = true;
        }
        return;
      }
      async function broadcastMessage (message_: string) {
        if (config.使用被动方式转发) {
          messageQueue.push(message_);
          if (!sessionFlag) {
            sessionFlag = true;
            ctx.setTimeout(async () => {
              logger.debug('计时结束');
              trySend();
            }, config.等待触发时长);
            logger.debug('开始计时');
          }
        } else {
          await bot.broadcast([config.收发消息的频道], `${message_}`);
        }
      }

      if (!/\[.*?\] <.*?>/.test(sendMessage)) {
        await broadcastMessage(sendMessage);
      } else {
        const messageParts = sendMessage.split(' ');
        if (messageParts.length > 2) {
          const modifiedMessage = messageParts.map((part, i) => {
            if (i === 1) {
              const dynamicContent = part.match(/<(.+?)>/)[1];
              return `${dynamicContent}说: `;
            }
            else if (i !== 2 || !config.指令转发MC消息) {
              return part;
            }
          }).filter(Boolean).join(' ');
          if (!config.指令转发MC消息 || (config.指令转发MC消息 && messageParts[2] === config.游戏内触发指令)) {
            await broadcastMessage(modifiedMessage)
          }
        }
      }
    }
    catch (error) {
      await handleError(error, sendMessage)
    }
  }

  async function handleError(error: any, sendMessage?: string) {
    // 主动推送上限，没遇到过，后续添加
    if (error.message.includes("(reading 'broadcast')")) {
      if (errorCount === 4) {
        logger.error('无法初始化 bot，请检查适配器和插件设置后再重启插件！');
        max = true;
        max_ = true;
      }
      if (!config.使用被动方式转发) {
        messageQueue.push(sendMessage)
      }
      bot = ctx.bots[`qqguild:${config.机器人账号}`];
      logger.debug('重新初始化 bot！');
      trySend();
      errorCount++;
    }
    else if (error.message.includes('限制')) {
      logger.warn('频道推送上限！');
      if (config.使用备用频道) {
        if (!config.使用被动方式转发) {
          messageQueue.push(sendMessage)
        }
        logger.info('尝试使用备用频道。');
        config.收发消息的频道 = config.备用转发频道;
        resetMax();
        if (!max) {
          max = true;
          trySend();
        } else {
          max_ = true;
        }
      } else {
        max = true;
        max_ = true;
        resetMax();
      }
    }
    else {
      logger.error('发生错误，请尝试重启插件: ', error);
    }

    function resetMax() {
      const now = new Date();
      const tomorrowMidnight = new Date(now);
      tomorrowMidnight.setHours(24, 0, 0, 0);
      const timeUntilTomorrowMidnight = tomorrowMidnight.getTime() - now.getTime();
      setTimeout(() => {
        max = false;
        max_ = false;
        if (config.使用备用频道) {
          config.收发消息的频道 = tempChannel;
        }
      }, timeUntilTomorrowMidnight);
    }
  }

  //使用前确保队列中有消息
  async function trySend() {
    try {
      const messageQueue_ = messageQueue.length;
      if (messageQueue_ > 0) {
        for (let i = 0; i < messageQueue_; i++) {
          await bot.broadcast([config.收发消息的频道], messageQueue[i]);
        }
      }
      sessionFlag = false;
      messageQueue = [];
    }
    catch (error) {
      handleError(error);
    }
  }
}