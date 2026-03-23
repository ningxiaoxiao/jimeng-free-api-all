import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import APIException from '@/lib/exceptions/APIException.ts';
import EX from '@/api/consts/exceptions.ts';
import { getTokenLiveStatus, getCredit, getTokenUserInfo, tokenSplit } from '@/api/controllers/core.ts';
import browserService from '@/lib/browser-service.ts';

function extractTokens(request: Request) {
    if (_.isString(request.headers.authorization) && request.headers.authorization.trim())
        return tokenSplit(request.headers.authorization);
    if (_.isString(request.body.token) && request.body.token.trim())
        return [request.body.token.trim()];
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, 'Params headers.authorization or body.token invalid');
}

export default {

    prefix: '/token',

    post: {

        '/check': async (request: Request) => {
            request
                .validate('body.token', _.isString)
            const live = await getTokenLiveStatus(request.body.token);
            return {
                live
            }
        },

        '/points': async (request: Request) => {
            request
                .validate('headers.authorization', _.isString)
            // 健康检查：验证浏览器是否在线，断开则自动重启
            const browserStatus = await browserService.healthCheck();
            // refresh_token切分
            const tokens = tokenSplit(request.headers.authorization);
            const points = await Promise.all(tokens.map(async (token) => {
                return {
                    token,
                    points: await getCredit(token)
                }
            }))
            return { points, browserStatus };
        },

        '/info': async (request: Request) => {
            const tokens = extractTokens(request);
            // 健康检查：验证浏览器是否在线，断开则自动重启
            const browserStatus = await browserService.healthCheck();
            const users = await Promise.all(tokens.map(token => getTokenUserInfo(token)));
            return {
                count: users.length,
                users,
                browserStatus
            };
        }

    }

}
