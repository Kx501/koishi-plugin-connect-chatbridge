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
exports.apply = exports.Config = exports.name = void 0;
const koishi_1 = require("koishi");
const WebSocket = __importStar(require("ws"));
const axios_1 = __importDefault(require("axios"));
exports.name = 'connect-chatbridge';
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
        urlAppSecret: koishi_1.Schema.string().role('secret').description('短链接服务的密钥，api 只有一个参数时填这里').required(),
    }).description('短链接服务相关设置')
]);
function apply(ctx, config) {
    let server = null;
    const bot = ctx.bots[`qqguild:${config.机器人账号}`];
    ctx.on('dispose', () => {
        closeServer();
    });
    ctx.on('ready', () => {
        closeServer();
        if (config.enable) {
            startServer();
        }
    });
    ctx.middleware(async (session, next) => {
        if (server && server.clients.size > 0 && session.event._data.d.channel_id == config.收发消息的频道) {
            const messageData = await processMessage(session.event);
            const messagePacket = createMessagePacket(session, messageData);
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
                console.log('握手成功，Token 验证通过。');
                socket.addEventListener('message', (event) => {
                    const receivedData = event.data;
                    let sendMessage_;
                    if (typeof receivedData === 'string') {
                        console.log(`接收到客户端消息: ${receivedData}`);
                        sendMessage_ = JSON.parse(receivedData).message;
                    }
                    else if (receivedData instanceof ArrayBuffer) {
                        console.log('接收到二进制数据');
                        // 如果需要处理二进制数据，请在此添加相应逻辑
                        return;
                    }
                    processWebSocketMessage(sendMessage_);
                });
                socket.addEventListener('close', (event) => {
                    console.log(event.code === 1006 ? '客户端成功断开' : `连接关闭，关闭代码: ${event.code}，原因: ${event.reason}`);
                });
            }
            else {
                socket.close();
                console.log('无效的 Token，连接已终止。');
                return;
            }
        });
        console.log('WebSocket 服务器已启动。');
    }
    function closeServer() {
        if (server) {
            server.clients.forEach(client => client.terminate());
            server.close();
            console.log(server.clients.size > 0 ? '已关闭未正确启动的 WebSocket 服务器。' : 'WebSocket 服务器已关闭。');
        }
    }
    function createMessagePacket(session, messageData) {
        return JSON.stringify({
            sender: session.event.user.name,
            message: `${messageData}`
        });
    }
    function sendMessageToClients(messagePacket) {
        server.clients.forEach(client => {
            client.send(messagePacket);
            console.log('发送消息成功！');
        });
    }
    function processWebSocketMessage(sendMessage_) {
        if (!config.指令转发MC消息 || !/\[.*?\] <.*?>/.test(sendMessage_)) {
            bot.broadcast([`${config.收发消息的频道}`], `${sendMessage_}`);
        }
        else {
            let messageParts = sendMessage_.split(' ');
            if (messageParts.length === 3) {
                let capturedText = messageParts[1];
                if (capturedText === config.游戏内触发指令) {
                    const modifiedMessage = `[${messageParts[0]}] <${messageParts[2]}>`;
                    if (capturedText === config.游戏内触发指令) {
                        bot.broadcast([`${config.收发消息的频道}`], `${modifiedMessage}`);
                    }
                }
            }
        }
    }
}
exports.apply = apply;
