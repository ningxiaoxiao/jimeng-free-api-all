import _ from "lodash";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import util from "@/lib/util.ts";
import { request } from "./core.ts";
import logger from "@/lib/logger.ts";

export const DEFAULT_MODEL = "jimeng-tts-1";

const DEFAULT_ASSISTANT_ID = 513695;
const DRAFT_VERSION = "3.3.11";
const DRAFT_MIN_VERSION = "3.2.3";
const DEFAULT_REFERER = "https://jimeng.jianying.com/ai-tool/generate";
const DEFAULT_RESPONSE_FORMAT = "mp3";
const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_VOICE_PLATFORM = 2;
const DEFAULT_MAX_RETRIES = 60;

export interface GenerateSpeechOptions {
  voiceId: string;
  voiceName?: string;
  format?: string;
  sampleRate?: number;
  speechRate?: number;
  pitchRate?: number;
  voicePlatform?: number;
  workspaceId?: number;
}

export interface SpeechAudioCandidate {
  url: string;
  format: string;
  duration_ms: number;
  size: number;
  item_id?: string;
  status?: number;
  cover_url?: string;
}

export interface SpeechGenerationResult {
  created: number;
  submitId: string;
  historyId: string;
  status: number;
  model: string;
  text: string;
  audios: SpeechAudioCandidate[];
}

function normalizeSpeechText(text: string) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function extractCandidates(itemList: any[]): SpeechAudioCandidate[] {
  return itemList
    .map((item) => {
      const originAudio = item?.audio?.origin_audio || {};
      const commonAttr = item?.common_attr || {};
      const url = originAudio.url || commonAttr.item_urls?.[0];
      if (!url) return null;
      return {
        url,
        format: originAudio.format || DEFAULT_RESPONSE_FORMAT,
        duration_ms: originAudio.duration_ms || 0,
        size: originAudio.size || 0,
        item_id: commonAttr.id,
        status: commonAttr.status,
        cover_url: commonAttr.cover_url,
      } as SpeechAudioCandidate;
    })
    .filter((item): item is SpeechAudioCandidate => !!item);
}

export async function generateSpeech(
  _model: string,
  input: string,
  {
    voiceId,
    voiceName = "我的音色",
    format = DEFAULT_RESPONSE_FORMAT,
    sampleRate = DEFAULT_SAMPLE_RATE,
    speechRate = 0,
    pitchRate = 0,
    voicePlatform = DEFAULT_VOICE_PLATFORM,
    workspaceId = 0,
  }: GenerateSpeechOptions,
  refreshToken: string
): Promise<SpeechGenerationResult> {
  const model = _.defaultTo(_model, DEFAULT_MODEL);
  const text = normalizeSpeechText(input);
  const submitId = util.uuid();
  const componentId = util.uuid();
  const createdAt = new Date().toISOString();

  logger.info(`使用 ${model} 提交 TTS 任务，voice_id: ${voiceId}`);

  await request("post", "/mweb/v1/workspace/update", refreshToken, {
    params: {
      os: "mac",
      da_version: DRAFT_VERSION,
      web_version: "7.5.0",
      aigc_features: "app_lip_sync",
    },
    headers: {
      Referer: DEFAULT_REFERER,
    },
    data: {
      workspace_id: workspaceId,
    },
  });

  const metricsExtra = JSON.stringify({
    isAiLyric: false,
    lyricCnt: 0,
    isRandomInspiration: false,
    promptSource: "custom",
    enterFrom: "click",
    position: "page_bottom_box",
    sceneOptions: JSON.stringify([
      {
        type: "audio",
        scene: "AudioTTSGenerate",
        audioDuration: 1,
      },
    ]),
    isRegenerate: false,
  });

  const { aigc_data } = await request(
    "post",
    "/mweb/v1/aigc_draft/generate",
    refreshToken,
    {
      params: {
        os: "mac",
        da_version: DRAFT_VERSION,
        web_version: "7.5.0",
        aigc_features: "app_lip_sync",
      },
      headers: {
        Referer: DEFAULT_REFERER,
      },
      data: {
        extend: {
          m_video_commerce_info_list: [
            {
              amount: 1,
              benefit_type: "audio_tts_generate",
              resource_id: "generate_audio",
              resource_id_type: "str",
              resource_sub_type: "aigc",
            },
          ],
          workspace_id: workspaceId,
        },
        submit_id: submitId,
        metrics_extra: metricsExtra,
        draft_content: JSON.stringify({
          type: "draft",
          id: util.uuid(),
          min_version: DRAFT_MIN_VERSION,
          min_features: [],
          is_from_tsn: true,
          version: DRAFT_VERSION,
          main_component_id: componentId,
          component_list: [
            {
              type: "audio_base_component",
              id: componentId,
              min_version: DRAFT_MIN_VERSION,
              aigc_mode: "workbench",
              metadata: {
                type: "",
                id: util.uuid(),
                created_platform: 3,
                created_platform_version: "",
                created_time_in_ms: createdAt,
                created_did: "",
              },
              generate_type: "generate_tts",
              abilities: {
                type: "",
                id: util.uuid(),
                text_to_speech: {
                  type: "",
                  id: util.uuid(),
                  text,
                  id_info: {
                    id: voiceId,
                    item_platform: voicePlatform,
                  },
                  audio_config: {
                    type: "",
                    id: util.uuid(),
                    format,
                    sample_rate: sampleRate,
                    speech_rate: speechRate,
                    pitch_rate: pitchRate,
                  },
                  voice_name: voiceName,
                },
              },
            },
          ],
        }),
        http_common_info: {
          aid: DEFAULT_ASSISTANT_ID,
        },
      },
    }
  );

  const historyId = aigc_data?.history_record_id;
  if (!historyId) {
    throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "TTS 记录ID不存在");
  }

  logger.info(`TTS 任务已提交，submit_id: ${submitId}, history_id: ${historyId}`);

  let status = aigc_data?.status || 20;
  let failCode = "";
  let itemList: any[] = [];
  let retryCount = 0;

  await new Promise((resolve) => setTimeout(resolve, 5000));

  while (retryCount < DEFAULT_MAX_RETRIES) {
    const result = await request("post", "/mweb/v1/get_history_by_ids", refreshToken, {
      params: {
        da_version: DRAFT_VERSION,
        web_version: "7.5.0",
        aigc_features: "app_lip_sync",
      },
      headers: {
        Referer: DEFAULT_REFERER,
        "x-platform": "pc",
      },
      data: {
        submit_ids: [submitId],
      },
    });

    const historyData = result?.[submitId] || result?.[historyId] || result?.history_list?.[0];

    if (!historyData) {
      retryCount++;
      const waitTime = Math.min(2000 * (retryCount + 1), 10000);
      logger.info(`TTS 轮询未命中结果，${waitTime}ms 后重试 (${retryCount}/${DEFAULT_MAX_RETRIES})`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      continue;
    }

    status = historyData.status ?? status;
    failCode = historyData.fail_code || "";
    itemList = historyData.item_list || [];

    logger.info(`TTS 状态: ${status}, fail_code: ${failCode || "无"}, item_list: ${itemList.length}`);

    if (status === 30) {
      throw new APIException(
        EX.API_IMAGE_GENERATION_FAILED,
        `TTS 生成失败，错误码: ${failCode || "unknown"}`
      );
    }

    const candidates = extractCandidates(itemList);
    if (status === 50 && candidates.length > 0) {
      return {
        created: util.unixTimestamp(),
        submitId,
        historyId,
        status,
        model,
        text: input,
        audios: candidates,
      };
    }

    retryCount++;
    const waitTime = status === 20 ? Math.min(2000 * (retryCount + 1), 10000) : 2000;
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  throw new APIException(EX.API_IMAGE_GENERATION_FAILED, "TTS 生成超时");
}
