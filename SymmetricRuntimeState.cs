using System.Text.Json;
using System.Text.Json.Serialization;

namespace 六合分析软件;

public sealed record SymmetricRuntimeStateSnapshot(
    [property: JsonPropertyName("schema_version")] string SchemaVersion,
    [property: JsonPropertyName("model_version")] string ModelVersion,
    [property: JsonPropertyName("code_version")] string CodeVersion,
    [property: JsonPropertyName("predictions")] IReadOnlyList<DatabaseHelper.PredictionRecord> Predictions,
    [property: JsonPropertyName("model_memory")] IReadOnlyDictionary<string, string> ModelMemory,
    [property: JsonPropertyName("state_hash")] string StateHash,
    [property: JsonPropertyName("generated_at")] string GeneratedAt);

public static class SymmetricRuntimeStateSync
{
    public static SymmetricRuntimeStateSnapshot Export(string codeVersion)
    {
        DatabaseHelper.InitializeDatabase();
        var memory = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string key in ExperimentModels.AllKeys.Append(ExperimentModels.IntelligentHistory).Distinct(StringComparer.Ordinal))
        {
            string? json = DatabaseHelper.LoadModelMemoryJson(ExperimentModels.MemoryKey(key));
            if (!string.IsNullOrWhiteSpace(json)) memory[ExperimentModels.MemoryKey(key)] = json;
        }
        var draft = new SymmetricRuntimeStateSnapshot("v1", AIEngine.Version, codeVersion,
            DatabaseHelper.GetPredictionHistory(int.MaxValue), memory, "", DateTimeOffset.UtcNow.ToString("O"));
        return draft with { StateHash = Hash(draft) };
    }

    public static string Hash(SymmetricRuntimeStateSnapshot snapshot)
    {
        // 规范哈希：不依赖 JsonSerializer 的转义/序列化细节（不同 .NET 环境可能输出不同），
        // 只按固定顺序拼接字段后用 SHA256，保证云端、本地、桌面端永远得到同一结果。
        const char sep = '\u001F'; // 单元分隔符，正常数据不会出现
        var payload = new System.Text.StringBuilder();
        payload.Append(snapshot.SchemaVersion).Append(sep);
        payload.Append(snapshot.ModelVersion).Append(sep);
        payload.Append(snapshot.CodeVersion);
        foreach (DatabaseHelper.PredictionRecord item in snapshot.Predictions
            .OrderBy(item => item.Issue, StringComparer.Ordinal)
            .ThenBy(item => item.ModelVersion, StringComparer.Ordinal)
            .ThenBy(item => item.AnalysisPeriods))
        {
            payload.Append(sep).Append("P");
            payload.Append(sep).Append(item.Issue);
            payload.Append(sep).Append(item.ModelVersion);
            payload.Append(sep).Append(item.AnalysisPeriods);
            payload.Append(sep).Append(item.PredictZodiac);
            payload.Append(sep).Append(item.Top6Zodiac);
            payload.Append(sep).Append(item.PredictNumber);
            payload.Append(sep).Append(item.HitResult);
            payload.Append(sep).Append(item.Top6HitResult);
            payload.Append(sep).Append(item.ActualZodiac);
            payload.Append(sep).Append(item.ActualNumber);
            payload.Append(sep).Append(item.ScoreDetails);
            payload.Append(sep).Append(item.ReviewDetails);
            payload.Append(sep).Append(item.LearningDetails);
            payload.Append(sep).Append(item.FinalRankingJson);
            payload.Append(sep).Append(item.BaseModelScoresJson);
            payload.Append(sep).Append(item.FeatureSnapshotJson);
            payload.Append(sep).Append(item.WeightSnapshotJson);
            payload.Append(sep).Append(item.MappingSnapshotJson);
            payload.Append(sep).Append(item.ActualRank);
            payload.Append(sep).Append(item.LearningStatus);
            payload.Append(sep).Append(item.LearnedAt);
            payload.Append(sep).Append(item.PredictTime);
            payload.Append(sep).Append(item.PredictionGroupId);
            payload.Append(sep).Append(item.PredictionSource);
        }
        foreach (KeyValuePair<string, string> entry in snapshot.ModelMemory.OrderBy(item => item.Key, StringComparer.Ordinal))
        {
            payload.Append(sep).Append("M");
            payload.Append(sep).Append(entry.Key);
            payload.Append(sep).Append(entry.Value);
        }
        return Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(payload.ToString())));
    }

    /// <summary>
    /// 仅补齐跨版本运行状态中的预测记录，不合并其模型记忆。
    /// V7 运行状态包含完整的 V6.5/V7 历史预测，但不能当作 V6.5 的学习状态覆盖本机。
    /// </summary>
    public static int MergePredictionsIntoLocal(SymmetricRuntimeStateSnapshot incoming)
    {
        if (incoming.SchemaVersion != "v1" ||
            !string.Equals(Hash(incoming), incoming.StateHash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("跨版本云端预测状态版本或哈希无效");
        DatabaseHelper.InitializeDatabase();
        return MergePredictionRows(incoming.Predictions);
    }

    public static int MergeIntoLocal(SymmetricRuntimeStateSnapshot incoming)
    {
        if (incoming.SchemaVersion != "v1" || incoming.ModelVersion != AIEngine.Version ||
            !string.Equals(Hash(incoming), incoming.StateHash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("云端模型状态版本或哈希无效");
        DatabaseHelper.InitializeDatabase();
        int merged = MergePredictionRows(incoming.Predictions);
        foreach ((string key, string json) in incoming.ModelMemory)
        {
            string? local = DatabaseHelper.LoadModelMemoryJson(key);
            if (string.IsNullOrWhiteSpace(local)) DatabaseHelper.SaveModelMemoryJson(key, json);
            else if (!string.Equals(local, json, StringComparison.Ordinal))
            {
                // 本机学习状态已有分叉时，预测快照仍可安全补齐；仅保留本机记忆，
                // 绝不能用云端状态覆盖它或令整批预测记录同步失败。
                AppLogger.Info("V6同构状态同步", $"模型记忆冲突，保留本机状态：{key}");
            }
        }
        return merged;
    }

    private static int MergePredictionRows(IReadOnlyList<DatabaseHelper.PredictionRecord> predictions)
    {
        int merged = 0;
        foreach (DatabaseHelper.PredictionRecord row in predictions)
        {
            row.PredictionSource = "云端同步";
            try
            {
                merged += DatabaseHelper.MergeSynchronizedPrediction(row);
            }
            catch (InvalidDataException)
            {
                // 本地已有首次快照且内容不同（例如每日档案与运行状态来自不同通道）：
                // 保留本地首次快照，跳过该行，不中断整批同步。
            }
        }
        return merged;
    }
}
