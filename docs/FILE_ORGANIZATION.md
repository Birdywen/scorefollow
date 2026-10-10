# 文件组织规则

## 目录结构

```
scorefollow/
├── docs/                    # 所有文档和规划
│   ├── tasks/              # OpenCode 任务文件 (TASK_*.md)
│   ├── reports/            # 测试报告和分析结果
│   ├── plans/              # 开发计划和变更日志
│   └── *.md                # 其他项目文档
├── tests/
│   ├── manual/             # 手动测试脚本 (*.mjs)
│   └── (future: unit/)     # 单元测试
├── public/Score/           # 乐谱文件 (PDF, MusicXML)
├── src/                    # 源代码
└── (root)                  # 仅保留配置文件和 README
```

## 新文件放置规则

### 任务文件
- **路径**: `docs/tasks/TASK_<功能>_<日期>.md`
- **用途**: 给 OpenCode worker 的任务说明
- **命名**: 大写 TASK_ 前缀，功能关键词，可选日期后缀

### 测试脚本
- **路径**: `tests/manual/<功能>-test.mjs`
- **用途**: Playwright 或 Node.js 验证脚本
- **命名**: 小写，连字符分隔，.mjs 后缀

### 开发文档
- **计划类**: `docs/plans/<主题>-PLAN.md`
- **总结类**: `docs/plans/<主题>-SUMMARY.md`
- **报告类**: `docs/reports/<功能>-REPORT.md`
- **其他**: `docs/<主题>.md`

### 乐谱资源
- **路径**: `public/Score/<曲目名>.pdf` 或 `.musicxml`
- **用途**: 用户上传的测试乐谱
- **注意**: scores.json 用于索引（当前为空，需实现）

### 源代码
- **组件**: `src/components/<Component>.tsx`
- **工具**: `src/lib/<utility>.ts`
- **类型**: `src/types/<domain>.ts`

## 根目录保留文件清单

仅保留以下配置和说明文件：
- `package.json`, `package-lock.json`
- `tsconfig.json`, `next.config.ts`
- `tailwind.config.ts`, `postcss.config.mjs`
- `README.md`
- `.gitignore`, `.env*`
- `AGENTS.md` (OpenCode worker 规则)

## Git 提交规范

- 任务文件和测试脚本：不提交到主分支，保留在开发分支或归档
- 文档：重要的计划和报告提交，临时笔记不提交
- 源代码：所有功能代码提交
- 乐谱文件：根据项目需要决定是否提交（大文件考虑 Git LFS）
