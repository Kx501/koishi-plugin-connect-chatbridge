import { Context, Schema } from 'koishi';
export declare const name = "connect-chatbridge";
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
}
export declare const Config: Schema<ConfigType>;
export declare function apply(ctx: Context, config: ConfigType): void;
export {};
