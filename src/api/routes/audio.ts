import _ from "lodash";
import axios from "axios";

import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import util from "@/lib/util.ts";
import { tokenSplit } from "@/api/controllers/core.ts";
import { DEFAULT_MODEL, generateSpeech } from "@/api/controllers/audio.ts";

function parseNumber(value: any, fallback: number) {
  if (_.isUndefined(value) || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default {
  prefix: "/v1/audio",

  post: {
    "/speech": async (request: Request) => {
      request
        .validate("body.model", (v) => _.isUndefined(v) || _.isString(v))
        .validate("body.input", _.isString)
        .validate("body.voice", (v) => _.isUndefined(v) || _.isString(v))
        .validate("body.voice_id", (v) => _.isUndefined(v) || _.isString(v))
        .validate("body.voice_name", (v) => _.isUndefined(v) || _.isString(v))
        .validate("body.response_format", (v) => _.isUndefined(v) || _.isString(v))
        .validate("body.sample_rate", (v) => _.isUndefined(v) || _.isFinite(v))
        .validate("body.speech_rate", (v) => _.isUndefined(v) || _.isFinite(v))
        .validate("body.pitch_rate", (v) => _.isUndefined(v) || _.isFinite(v))
        .validate("body.voice_platform", (v) => _.isUndefined(v) || _.isFinite(v))
        .validate("body.candidate_index", (v) => _.isUndefined(v) || (_.isFinite(v) && v >= 0))
        .validate("headers.authorization", _.isString);

      const tokens = tokenSplit(request.headers.authorization);
      const token = _.sample(tokens);

      const {
        model = DEFAULT_MODEL,
        input,
        voice,
        voice_id,
        voice_name,
        response_format = "url",
        sample_rate,
        speech_rate,
        pitch_rate,
        voice_platform,
        candidate_index = 0,
      } = request.body;

      const voiceId = voice_id || voice;
      if (!voiceId) {
        throw new Error("缺少 voice_id（或兼容字段 voice）");
      }

      const result = await generateSpeech(
        model,
        input,
        {
          voiceId,
          voiceName: voice_name,
          sampleRate: parseNumber(sample_rate, 24000),
          speechRate: parseNumber(speech_rate, 0),
          pitchRate: parseNumber(pitch_rate, 0),
          voicePlatform: parseNumber(voice_platform, 2),
        },
        token
      );

      const selectedIndex = Math.min(
        Math.max(parseNumber(candidate_index, 0), 0),
        Math.max(result.audios.length - 1, 0)
      );
      const selectedAudio = result.audios[selectedIndex];

      if (!selectedAudio) {
        throw new Error("TTS 未返回可用音频");
      }

      if (response_format === "b64_json") {
        const b64 = await util.fetchFileBASE64(selectedAudio.url);
        return {
          created: result.created,
          model: result.model,
          submit_id: result.submitId,
          history_id: result.historyId,
          selected_index: selectedIndex,
          data: [
            {
              b64_json: b64,
              format: selectedAudio.format,
              duration_ms: selectedAudio.duration_ms,
              size: selectedAudio.size,
            },
          ],
          variants: result.audios,
        };
      }

      if (["mp3", "binary", "audio"].includes(response_format)) {
        const audioResponse = await axios.get(selectedAudio.url, {
          responseType: "arraybuffer",
        });
        return new Response(Buffer.from(audioResponse.data), {
          type: "audio/mpeg",
          headers: {
            "Content-Disposition": `inline; filename=\"${selectedAudio.item_id || util.uuid(false)}.mp3\"`,
            "X-Jimeng-Submit-Id": result.submitId,
            "X-Jimeng-History-Id": result.historyId,
          },
        });
      }

      return {
        created: result.created,
        model: result.model,
        submit_id: result.submitId,
        history_id: result.historyId,
        selected_index: selectedIndex,
        data: [
          {
            ...selectedAudio,
          },
        ],
        variants: result.audios,
      };
    },
  },
};
