# 海林市高级中学校友会官方网站：前台 + 后台接口版

这是一个原创高校门户风格官网模板，包含：

- GitHub Pages 前台静态网站
- 管理员后台入口 `/admin/`
- Node.js 后端接口服务 `/server/`
- 校友登记表单提交接口
- 管理员登录、查看、审批申请功能

## 文件说明

```text
index.html          官网首页
style.css           官网样式
script.js           官网交互与表单提交
config.js           前端接口地址配置
assets/             图片资源
admin/              管理员后台页面
server/             Node.js 后端接口服务
后台与接口说明.md    后台入口、接口、端口说明
```

## 前台部署到 GitHub Pages

把根目录里的这些内容上传到 GitHub 仓库根目录：

```text
index.html
style.css
script.js
config.js
assets/
admin/
README.md
后台与接口说明.md
```

然后在 GitHub：

```text
Settings → Pages → Deploy from a branch → main → / root → Save
```

管理员入口：

```text
https://zxw-hub.github.io/hailin-high-school-alumni/admin/
```

## 后端部署

GitHub Pages 不能运行后端，所以 `server/` 需要单独部署到 Node.js 服务器。

本地测试：

```bash
cd server
npm install
cp .env.example .env
npm start
```

默认端口：

```text
3000
```

本地接口：

```text
http://localhost:3000/api/applications
```

后端上线后，修改 `config.js`：

```js
window.HAILIN_CONFIG = {
  API_BASE_URL: "你的后端服务地址"
};
```
