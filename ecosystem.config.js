module.exports = {
  apps: [
    {
      name: 'quizbot-server',
      cwd: '/server',
      script: 'server/src/index.js',
      interpreter: 'node',
      args: '--disable-warning=ExperimentalWarning',
      env: {
        PORT: 4000,
        NODE_ENV: 'production',
      },
      max_restarts: 10,
      min_uptime: '10s',
      autorestart: true,
      watch: false,
      log_file: '/quizbot-combined.log',
      out_file: '/quizbot-out.log',
      error_file: '/quizbot-error.log',
      time: true,
    },
  ],
};
