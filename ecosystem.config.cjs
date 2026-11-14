module.exports = {
  apps: [
    {
      name: "my-whatsapp-bot",
      cwd: __dirname,
      // Run Bun directly so index.js remains the main module.
      script: `${process.env.HOME}/.bun/bin/bun`,
      args: ["run", "index.js"],
      interpreter: "none",

      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      // Runtime credential and image writes must not restart the process.
      watch: false,

      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
