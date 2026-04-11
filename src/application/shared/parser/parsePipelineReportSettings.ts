import { z } from 'zod';
import { PipelineReportSettings } from '../../../domain/pipeline-report/pipelineReportSettings/PipelineReportSettings.js';
import { DEFAULT_JOB_REPORT_FORMAT } from '../../pipeline-report/pipelineAnalysis/defaultReportFormat.js';
import { PipelineReportSettingsParseError } from './PipelineReportSettingsParseError.js';

/**
 * pipeline-report 設定ファイルのスキーマ。
 * 全フィールドはオプショナルで、未指定時はデフォルトが適用される。
 */
const schema = z.object({
  jobReportFormat: z.string().optional(),
  additionalInstructions: z.string().nullable().optional(),
  includeJobPatterns: z.array(z.string()).optional(),
  excludeJobPatterns: z.array(z.string()).optional(),
});

/**
 * pipeline-report 設定 JSON をパースして PipelineReportSettings を構築する。
 *
 * 失敗時は以下の 3 系統で {@link PipelineReportSettingsParseError} を投げる:
 * 1. JSON 構文エラー
 * 2. スキーマ不整合（型・shape 不一致）
 * 3. includeJobPatterns / excludeJobPatterns 内の不正な RegExp
 */
export function parsePipelineReportSettings(jsonText: string): PipelineReportSettings {
  // JSON 構文チェック
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (err) {
    throw new PipelineReportSettingsParseError(
      `pipeline-report settings file is not valid JSON: ${(err as Error).message}`,
      err,
    );
  }

  // スキーマバリデーション
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new PipelineReportSettingsParseError(
      `pipeline-report settings file has invalid shape: ${parsed.error.message}`,
      parsed.error,
    );
  }

  // パターン文字列を RegExp にコンパイルするヘルパ
  const compile = (patterns: string[] | undefined): RegExp[] => {
    if (!patterns) return [];
    return patterns.map((src) => {
      try {
        return new RegExp(src);
      } catch (err) {
        throw new PipelineReportSettingsParseError(
          `pipeline-report settings contains an invalid RegExp: "${src}" — ${(err as Error).message}`,
          err,
        );
      }
    });
  };

  return PipelineReportSettings.of({
    jobReportFormat: parsed.data.jobReportFormat ?? DEFAULT_JOB_REPORT_FORMAT,
    additionalInstructions: parsed.data.additionalInstructions ?? null,
    includeJobPatterns: compile(parsed.data.includeJobPatterns),
    excludeJobPatterns: compile(parsed.data.excludeJobPatterns),
  });
}
