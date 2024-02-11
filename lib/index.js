"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.apply = exports.Config = exports.usage = exports.name = void 0;
const koishi_1 = require("koishi");
const WebSocket = __importStar(require("ws"));
const axios_1 = __importDefault(require("axios"));
exports.name = 'connect-chatbridge';
exports.usage = `
短网址服务采用: https://www.urlc.cn/

修改后的Chatbridge见: https://github.com/Kxy051/ChatBridge
`;
exports.Config = koishi_1.Schema.intersect([
    koishi_1.Schema.object({
        enable: koishi_1.Schema.boolean().default(false).description('是否开启 WebSocket 转发'),
        port: koishi_1.Schema.number().default(5555).description('WebSocket 端口'),
        token: koishi_1.Schema.string().role('secret').description('建立 WebSocket 连接的 token')
    }).description('WebSocket 相关设置'),
    koishi_1.Schema.object({
        收发消息的频道: koishi_1.Schema.string().description('转发消息的子频道号').required(),
        机器人账号: koishi_1.Schema.string().description('机器人频道 id').required(),
        指令转发QQ消息: koishi_1.Schema.boolean().default(false).description('直接转发 QQ 消息到 Minecraft'),
        频道内触发指令: koishi_1.Schema.string().default('mc').description('QQ 内发送消息到 Minecraft 的指令，如果有前缀请加上。'),
        指令转发MC消息: koishi_1.Schema.boolean().default(false).description('直接转发 Minecraft 消息到 QQ'),
        游戏内触发指令: koishi_1.Schema.string().default('qq').description('Minecraft 内发送消息到 QQ 的指令，如果有前缀请加上。'),
    }).description('消息相关设置'),
    koishi_1.Schema.object({
        urlAppId: koishi_1.Schema.string().role('secret').description('短链接服务的 id').deprecated(),
        urlAppSecret: koishi_1.Schema.string().role('secret').description('短链接服务的密钥，api 只有一个参数时填这里。').required(),
    }).description('短链接服务相关设置'),
    koishi_1.Schema.object({
        使用被动方式转发: koishi_1.Schema.boolean().default(false).description('当频道内有人发言时才发送消息，配合触发时长使用。').experimental(),
        等待触发时长: koishi_1.Schema.number().default(2000).description('(毫秒) 超时采用主动发送，启用后转发消息到 QQ 会有延迟。效果自行测试。').experimental(),
        使用备用频道: koishi_1.Schema.boolean().default(false).description('如果采用主动消息转发，在单个频道推送上限后向备用频道推送。').experimental(),
        备用转发频道: koishi_1.Schema.string().description('备用的频道号').experimental(),
    }).description('其他设置')
]);
function apply(ctx, config) {
    let server = null, bot = null, messageQueue = [], sessionFlag = false, triggerSuccess = false, max = false, max_ = false, hasExecuted = false, errorCount = 0;
    const logger = new koishi_1.Logger('connect-chatbridge');
    ctx.on('dispose', () => {
        closeServer();
        logger.info('WebSocket 服务器已关闭。');
    });
    ctx.on('ready', () => {
        if (server) {
            closeServer();
            logger.info('已关闭未正确关闭的 WebSocket 服务器。');
        }
        if (config.enable) {
            logger.debug('调试模式开启！');
            bot = ctx.bots[`qqguild:${config.机器人账号}`];
            startServer();
            logger.success('WebSocket 服务器已启动。');
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
        }
        else {
            return next();
        }
    });
    async function processMessage(sessionEvent) {
        let attrsTemp = '';
        for (let i = 0; i < sessionEvent.message.elements.length; i++) {
            attrsTemp += await processElement(sessionEvent.message.elements[i]);
        }
        if (config.指令转发QQ消息) {
            attrsTemp = attrsTemp.slice(attrsTemp.indexOf(' ') + 1);
        }
        return attrsTemp;
    }
    async function processElement(element) {
        let innerAttrsTemp = '';
        if (element.type.includes('emoji')) {
            innerAttrsTemp += ` /${element.type} `;
            if (element.children.length > 0) {
                for (let j = 0; j < element.children.length; j++) {
                    innerAttrsTemp += await processElement(element.children[j]);
                }
            }
        }
        else if (element.type === 'img') {
            innerAttrsTemp += ` [表情/图片] ${await generateShortUrl(element.attrs.src)}`;
        }
        else if (element.type === 'text') {
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
    async function generateShortUrl(originalUrl) {
        try {
            const formattedTomorrow = new Date(new Date().setDate(new Date().getDate() + 1)).toLocaleDateString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
            });
            const requestData = { url: originalUrl, expiry: formattedTomorrow };
            const headers = { 'Authorization': 'Token ' + config.urlAppSecret, 'Content-Type': 'application/json' };
            const response = await axios_1.default.post('https://www.urlc.cn/api/url/add', requestData, { headers });
            const { error, short, msg } = response.data;
            if (error === 0) {
                return short;
            }
            else {
                throw new Error(`Error: ${msg}`);
            }
        }
        catch (error) {
            throw new Error(`Error in generateShortUrl: ${error}`);
        }
    }
    function startServer() {
        server = new WebSocket.Server({ port: config.port });
        server.on('connection', (socket, req) => {
            const wsUrl = new URL(req.url, `http://${req.headers.host}`);
            const accessToken = wsUrl.searchParams.get('access_token');
            if (config.token === accessToken) {
                logger.info('Token 验证通过，连接成功。');
                socket.addEventListener('message', (event) => {
                    const receivedData = event.data;
                    if (typeof receivedData === 'string') {
                        logger.debug(`接收到MC消息: ${receivedData}`);
                        const sendMessage_ = JSON.parse(receivedData).message;
                        processWebSocketMessage(sendMessage_);
                    }
                    else if (receivedData instanceof ArrayBuffer) {
                        logger.warn('接收到二进制数据，暂无处理逻辑！');
                        // 如果需要处理二进制数据，请在此添加相应逻辑
                        return;
                    }
                });
                socket.addEventListener('close', (event) => {
                    if (event.code !== 1006) {
                        logger.warn(`连接关闭，关闭代码: ${event.code}，原因: ${event.reason}`);
                    }
                });
            }
            else {
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
                client.terminate();
            }
            server.close();
        }
    }
    function createMessagePacket(sessionUser, messageData) {
        return JSON.stringify({
            sender: sessionUser,
            message: `${messageData}`
        });
    }
    function sendMessageToClients(messagePacket) {
        const client = server.clients.values().next().value;
        logger.debug(`将转发QQ消息: ${messagePacket}`);
        client.send(messagePacket);
        logger.debug('QQ消息转发成功！');
    }
    async function processWebSocketMessage(sendMessage_) {
        try {
            if (max && max_) {
                if (!hasExecuted) {
                    const endPacket = JSON.stringify({
                        sender: 'Koshi',
                        message: '今日消息推送上限，不再向QQ转发消息！'
                    });
                    sendMessageToClients(endPacket);
                    hasExecuted = true;
                }
                return;
            }
            const broadcastMessage = async (message_) => {
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
                }
                else {
                    await bot.broadcast([config.收发消息的频道], `${message_}`);
                }
            };
            if (!/\[.*?\] <.*?>/.test(sendMessage_)) {
                await broadcastMessage(sendMessage_);
            }
            else {
                const messageParts = sendMessage_.split(' ');
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
                        await broadcastMessage(modifiedMessage);
                    }
                }
            }
        }
        catch (error) {
            await handleError(error);
        }
    }
    async function handleError(error) {
        // 主动推送上限，没遇到过，后续添加
        if (error.message.includes("(reading 'broadcast')")) {
            if (errorCount > 6) {
                logger.error('无法初始化 bot，请检查适配器和插件设置后再重启插件！');
                max = true;
                max_ = true;
            }
            bot = ctx.bots[`qqguild:${config.机器人账号}`];
            logger.debug('重新初始化 bot！');
            trySend();
            errorCount++;
        }
        else if (error.message.includes('限制')) {
            logger.warn('频道推送上限！');
            if (config.使用备用频道) {
                logger.info('尝试使用备用频道。');
                config.收发消息的频道 = config.备用转发频道;
                if (!max) {
                    max = true;
                    trySend();
                }
                else {
                    max_ = true;
                }
            }
            else {
                max = true;
                max_ = true;
            }
        }
        else {
            logger.error('发生错误，请尝试重启插件: ', error);
        }
    }
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
exports.apply = apply;
