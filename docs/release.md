# Release Process

本项目默认使用 npm Trusted Publishing 发布，不使用本地 npm token，也不在 GitHub Secrets 中保存 `NPM_TOKEN`。

## 默认发布原则

- 稳定版发布到 npm `latest` dist-tag。
- 预览版发布到 npm `next` dist-tag。
- 发布动作必须由 GitHub Actions 里的 `.github/workflows/npm-publish.yml` 执行。
- 本地只负责改版本、提交、推送 tag；不要在本机直接执行 `npm publish` 发布正式包。

## 前置条件

npm 包 `wechat-acp-codex` 需要在 npmjs.com 配置 Trusted Publisher：

- Publisher: GitHub Actions
- Repository: `gangtiser/wechat-acp-codex`
- Workflow filename: `npm-publish.yml`
- Environment: 留空
- Allowed action: `npm publish`

workflow 需要 `id-token: write` 权限，并使用 `npm publish --provenance --access public`。

## 发布稳定版

1. 确认工作区干净：

   ```bash
   git status --short --branch
   ```

2. 更新版本号：

   ```bash
   npm version <version> --no-git-tag-version
   ```

3. 更新 `CHANGELOG.md`。

4. 跑发布前验证：

   ```bash
   npm test
   npm run build
   git diff --check
   npm pack --dry-run --cache /tmp/wechat-acp-npm-cache
   ```

5. 提交并推送 `main`：

   ```bash
   git add .
   git commit -m "feat: ..."
   git push origin main
   ```

6. 创建并推送版本 tag：

   ```bash
   git tag -a v<version> -m "v<version>"
   git push origin v<version>
   ```

   推送 `v*` tag 会触发 `publish-release` job，发布到 npm `latest`。

7. 验证 GitHub Actions 和 npm registry：

   ```bash
   npm view wechat-acp-codex version --registry https://registry.npmjs.org/
   npm view wechat-acp-codex dist-tags --json --registry https://registry.npmjs.org/
   ```

## 预览版发布

推送到 `main` 会触发 `publish-next` job。workflow 会自动计算：

```text
<base-version>-next.<UTC timestamp>.<short sha>
```

并发布到 npm `next` dist-tag。不要为 `next` 版本手动修改 `package.json` 或创建 tag。

也可以在 GitHub Actions 页面手动运行 `publish-npm` workflow，触发同样的 `next` 发布逻辑。

## 失败排查

- `npm publish` 401/404：确认 npm Trusted Publisher 配置的 repo 和 workflow 文件名是 `gangtiser/wechat-acp-codex` / `npm-publish.yml`。
- tag 与版本不匹配：`publish-release` 会比较 `v<version>` tag 和 `package.json` 版本，不一致会失败。
- 本地 npm cache 权限问题：本地 dry run 使用 `--cache /tmp/wechat-acp-npm-cache`。
- 不要改 workflow 里的 `setup-node` 为 token registry 模式；空的 `NODE_AUTH_TOKEN` 会影响 OIDC 发布。
