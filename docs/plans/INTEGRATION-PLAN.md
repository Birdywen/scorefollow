# 验证模块集成计划

**分支**: feature/integrate-validation-modules  
**基于**: main (058da60)  
**目标**: 将新创建的验证、错误消息、性能监控模块集成到核心分析引擎

## 背景

前一个开发周期创建了三个基础设施模块：
- `performance_monitor.py` - 性能追踪装饰器
- `error_messages.py` - 用户友好的中文错误消息
- `validation.py` - 音频和乐谱验证工具

这些模块目前独立存在，尚未集成到 `engine.py` 和 `piano_engine.py` 中。

## 集成目标

### 第一阶段：引入验证层（低风险）

1. **在 engine.py 中集成 validation.py**
   - 替换现有的手工 WAV 解析为 `validate_wav_audio()`
   - 使用 `validate_musicxml()` 进行 XML 安全检查
   - 使用 `validate_bpm()` 和 `validate_instrument()` 进行参数验证
   - 保持现有的 ValueError 向后兼容

2. **迁移错误消息到 error_messages.py**
   - 逐步替换硬编码的中文错误字符串
   - 使用新的异常类（AudioValidationError, ScoreValidationError 等）
   - 保持错误消息的可读性和可操作性

3. **添加性能监控点**
   - 在关键函数上添加 `@track_performance` 装饰器
   - 监控：parse_score, track, locate_excerpt, classify_pitch
   - 在 analyze() 返回结果中可选包含性能统计

### 第二阶段：增强算法（中风险）

4. **改进音频预处理**
   - 增强低信噪比处理
   - 改进归一化策略
   - 添加自适应阈值

5. **优化片段定位置信度**
   - 改进 DTW 成本评估
   - 增强重复乐句检测
   - 提供更详细的定位诊断信息

### 第三阶段：测试和验证

6. **回归测试**
   - 确保所有 71 个现有测试通过
   - 性能基准不退化（precision ≥ 0.978, recall ≥ 0.991）
   - 添加新的集成测试

7. **性能基准测试**
   - 运行 benchmarks/gt-eval.py
   - 记录性能变化
   - 验证错误消息改进

## 实施原则

1. **渐进式集成**：每次只集成一个模块，验证后再继续
2. **向后兼容**：保持现有 API 和错误类型
3. **测试驱动**：每次改动后运行完整测试套件
4. **详细记录**：每个提交都有清晰的描述和理由
5. **性能守护**：不降低现有的准确率和召回率

## 提交策略

遵循项目现有的提交风格：
- 简短的祈使句标题（<72 字符）
- 详细的提交消息说明动机和影响
- 引用相关的 issue 或测试
- 每个提交都是可独立审查的原子性改动

参考现有提交风格：
```
short descriptive title (#issue if applicable)

Detailed explanation of what changed and why.
Include context about the problem being solved.
Mention any tradeoffs or alternative approaches considered.

Test coverage: describe which tests verify this change.
Performance impact: note any timing or accuracy changes.
```

## 风险评估

**低风险改动**：
- 添加装饰器（不改变函数行为）
- 使用新的验证函数（功能等价替换）
- 错误消息改进（不改变异常类型）

**中风险改动**：
- 音频预处理算法调整
- DTW 参数优化
- 添加新的验证检查（可能拒绝之前接受的输入）

**缓解措施**：
- 每个改动后立即运行测试套件
- 保留原有实现作为参考
- 使用 git bisect 快速定位回归

## 成功标准

- ✅ 所有 71 个测试通过
- ✅ 性能基准保持或改进
- ✅ 错误消息更友好且可操作
- ✅ 代码可读性提高
- ✅ 无破坏性 API 变更
