import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { tokenSplit } from '@/api/controllers/core.ts';
import {
    generateVideo,
    generateSeedanceVideo,
    isSeedanceModel,
    DEFAULT_MODEL,
    getHistoryQueueInfo,
    listSavedVideoTasks,
    querySeedanceVideoTask,
    getVideoTaskStorePath,
} from '@/api/controllers/videos.ts';
import util from '@/lib/util.ts';

function parseArrayField(fieldName: string, value: any) {
    if (_.isUndefined(value) || value === null || value === '') return undefined;
    if (_.isArray(value)) return value;
    if (_.isString(value)) {
        try {
            const parsed = JSON.parse(value);
            if (_.isArray(parsed)) return parsed;
        } catch { }
    }
    throw new Error(`${fieldName} 必须是数组或 JSON 数组字符串`);
}

function parseNumberField(fieldName: string, value: any) {
    if (_.isUndefined(value) || value === null || value === '') return undefined;
    if (_.isFinite(value)) return Number(value);
    if (_.isString(value)) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    throw new Error(`${fieldName} 必须是数字`);
}

function parseBooleanField(fieldName: string, value: any) {
    if (_.isUndefined(value) || value === null || value === '') return undefined;
    if (_.isBoolean(value)) return value;
    if (_.isString(value)) {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    }
    throw new Error(`${fieldName} 必须是布尔值`);
}

function normalizeRatio(value: string | undefined) {
    if (!_.isString(value)) return value;
    return value.replace(/：/g, ':').trim();
}

export default {

    prefix: '/v1/videos',

    get: {

        '/tasks': async (request: Request) => {
            const limit = parseNumberField('limit', request.query.limit) || 50;
            return {
                file: getVideoTaskStorePath(),
                data: listSavedVideoTasks(limit),
            };
        },

        '/tasks/:historyId': async (request: Request) => {
            request
                .validate('params.historyId', _.isString)
                .validate('headers.authorization', _.isString);

            const tokens = tokenSplit(request.headers.authorization);
            const token = _.sample(tokens);
            const result = await querySeedanceVideoTask(request.params.historyId, token);

            return result;
        },

    },

    post: {

        '/get_history_queue_info': async (request: Request) => {
            request
                .validate('body.history_ids', v => _.isUndefined(v) || _.isArray(v) || _.isString(v))
                .validate('body.historyIds', v => _.isUndefined(v) || _.isArray(v) || _.isString(v))
                .validate('body.history_id', v => _.isUndefined(v) || _.isString(v) || _.isFinite(v))
                .validate('body.historyId', v => _.isUndefined(v) || _.isString(v) || _.isFinite(v))
                .validate('headers.authorization', _.isString);

            const tokens = tokenSplit(request.headers.authorization);
            const token = _.sample(tokens);
            const historyIdsField = !_.isUndefined(request.body.historyIds)
                ? request.body.historyIds
                : request.body.history_ids;
            const parsedHistoryIds = parseArrayField('history_ids', historyIdsField);
            const singleHistoryId = !_.isUndefined(request.body.historyId)
                ? request.body.historyId
                : request.body.history_id;
            const historyIds = parsedHistoryIds
                || (_.isUndefined(singleHistoryId) || singleHistoryId === null || singleHistoryId === ''
                    ? []
                    : [String(singleHistoryId)]);

            if (!historyIds.length) {
                throw new Error('缺少 history_ids（或兼容字段 historyIds/history_id/historyId）');
            }

            return await getHistoryQueueInfo(historyIds.map(v => String(v)), token);
        },

        '/generations': async (request: Request) => {
            // 检查是否使用了不支持的参数
            const unsupportedParams = ['size', 'width', 'height'];
            const bodyKeys = Object.keys(request.body);
            const foundUnsupported = unsupportedParams.filter(param => bodyKeys.includes(param));

            if (foundUnsupported.length > 0) {
                throw new Error(`不支持的参数: ${foundUnsupported.join(', ')}。请使用 ratio 和 resolution 参数控制视频尺寸。`);
            }

            const removedSeedanceParams = ['materials', 'material_list', 'materialList', 'meta_list', 'metaList'];
            const foundRemovedSeedanceParams = removedSeedanceParams.filter(param => bodyKeys.includes(param));
            if (foundRemovedSeedanceParams.length > 0) {
                throw new Error(`不再支持参数: ${foundRemovedSeedanceParams.join(', ')}。请改用 files 或 file_paths 重新上传素材。`);
            }

            const contentType = request.headers['content-type'] || '';
            const isMultiPart = contentType.startsWith('multipart/form-data');

            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.prompt', v => _.isUndefined(v) || _.isString(v))
                .validate('body.ratio', v => _.isUndefined(v) || _.isString(v))
                .validate('body.resolution', v => _.isUndefined(v) || _.isString(v))
                .validate('body.duration', v => {
                    if (_.isUndefined(v)) return true;
                    // 对于 multipart/form-data，允许字符串类型的数字
                    if (isMultiPart && typeof v === 'string') {
                        const num = parseInt(v);
                        // Seedance 支持 4-15 秒连续范围，普通视频支持 5 或 10 秒
                        return (num >= 4 && num <= 15) || num === 5 || num === 10;
                    }
                    // 对于 JSON，要求数字类型
                    // Seedance 支持 4-15 秒连续范围，普通视频支持 5 或 10 秒
                    return _.isFinite(v) && ((v >= 4 && v <= 15) || v === 5 || v === 10);
                })
                .validate('body.file_paths', v => _.isUndefined(v) || _.isArray(v))
                .validate('body.filePaths', v => _.isUndefined(v) || _.isArray(v))
                .validate('body.seed', v => _.isUndefined(v) || _.isFinite(v) || _.isString(v))
                .validate('body.workspace_id', v => _.isUndefined(v) || _.isFinite(v) || _.isString(v))
                .validate('body.workspaceId', v => _.isUndefined(v) || _.isFinite(v) || _.isString(v))
                .validate('body.async', v => _.isUndefined(v) || _.isBoolean(v) || _.isString(v))
                .validate('body.wait_for_result', v => _.isUndefined(v) || _.isBoolean(v) || _.isString(v))
                .validate('body.waitForResult', v => _.isUndefined(v) || _.isBoolean(v) || _.isString(v))
                .validate('body.response_format', v => _.isUndefined(v) || _.isString(v))
                .validate('headers.authorization', _.isString);

            // refresh_token切分
            const tokens = tokenSplit(request.headers.authorization);
            // 随机挑选一个refresh_token
            const token = _.sample(tokens);

            const {
                model = DEFAULT_MODEL,
                prompt,
                ratio = "1:1",
                resolution = "720p",
                duration = 5,
                file_paths = [],
                filePaths = [],
                seed,
                workspace_id,
                workspaceId,
                async: asyncMode,
                wait_for_result,
                waitForResult,
                response_format = "url"
            } = request.body;

            // 如果是 multipart/form-data，需要将字符串转换为数字
            const finalDuration = isMultiPart && typeof duration === 'string'
                ? parseInt(duration)
                : duration;

            // 兼容两种参数名格式：file_paths 和 filePaths
            const finalFilePaths = filePaths.length > 0 ? filePaths : file_paths;
            const finalRatio = normalizeRatio(ratio) || "1:1";
            const finalSeed = parseNumberField('seed', seed);
            const finalWorkspaceId = parseNumberField(
                'workspace_id',
                !_.isUndefined(workspaceId) ? workspaceId : workspace_id
            );
            const finalAsync = parseBooleanField('async', asyncMode);
            const finalWaitForResultField = parseBooleanField(
                'wait_for_result',
                !_.isUndefined(waitForResult) ? waitForResult : wait_for_result
            );
            const finalWaitForResult = _.isBoolean(finalWaitForResultField)
                ? finalWaitForResultField
                : finalAsync === false
                    ? true
                    : false;

            if (!finalWaitForResult && response_format === "b64_json") {
                throw new Error('async 提交不支持 b64_json，请使用 url 格式');
            }

            // 根据模型类型选择不同的生成函数
            let videoUrl: string;
            let seedanceResult;
            if (isSeedanceModel(model)) {
                // Seedance 2.0 智能视频生成（支持文生和多素材）
                // Seedance 默认时长为 4 秒，默认比例为 4:3
                const seedanceDuration = finalDuration;
                const seedanceRatio = finalRatio;

                seedanceResult = await generateSeedanceVideo(
                    model,
                    prompt || "",
                    {
                        ratio: seedanceRatio,
                        resolution,
                        duration: seedanceDuration,
                        filePaths: finalFilePaths,
                        files: request.files,
                        seed: finalSeed,
                        workspaceId: finalWorkspaceId,
                        waitForResult: finalWaitForResult,
                    },
                    token
                );

                if (finalWaitForResult) {
                    videoUrl = seedanceResult.url;
                }
            } else {
                if (!finalWaitForResult) {
                    throw new Error('async 提交当前仅支持 Seedance 视频模型');
                }
                // 普通视频生成
                videoUrl = await generateVideo(
                    model,
                    prompt || "",
                    {
                        ratio: finalRatio,
                        resolution,
                        duration: finalDuration,
                        filePaths: finalFilePaths,
                        files: request.files,
                    },
                    token
                );
            }

            if (seedanceResult && !finalWaitForResult) {
                return {
                    created: seedanceResult.created,
                    model: seedanceResult.model,
                    submit_id: seedanceResult.submitId,
                    history_id: seedanceResult.historyId,
                    task_status: seedanceResult.taskStatus,
                    save_path: seedanceResult.savePath,
                    data: [],
                };
            }

            // 根据response_format返回不同格式的结果
            if (response_format === "b64_json") {
                // 获取视频内容并转换为BASE64
                const videoBase64 = await util.fetchFileBASE64(videoUrl);
                return {
                    created: util.unixTimestamp(),
                    ...(seedanceResult ? {
                        model: seedanceResult.model,
                        submit_id: seedanceResult.submitId,
                        history_id: seedanceResult.historyId,
                        task_status: seedanceResult.taskStatus,
                        save_path: seedanceResult.savePath,
                    } : {}),
                    data: [{
                        b64_json: videoBase64,
                        revised_prompt: prompt
                    }]
                };
            } else {
                // 默认返回URL
                return {
                    created: util.unixTimestamp(),
                    ...(seedanceResult ? {
                        model: seedanceResult.model,
                        submit_id: seedanceResult.submitId,
                        history_id: seedanceResult.historyId,
                        task_status: seedanceResult.taskStatus,
                        save_path: seedanceResult.savePath,
                    } : {}),
                    data: [{
                        url: videoUrl,
                        revised_prompt: prompt
                    }]
                };
            }
        }

    }

}
