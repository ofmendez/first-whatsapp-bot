
module.exports = {
  apps: [
    {
      name: "my-whatsapp-bot",
      script: "./index.js",
      cwd: __dirname,
      interpreter: `${process.env.HOME}/.bun/bin/bun`,

      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,

      env: {
        NODE_ENV: "production",
        PORT: "3000"
      }
    }
  ]
};
