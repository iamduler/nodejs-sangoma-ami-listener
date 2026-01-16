module.exports = {
  apps: [
    {
      name: 'ami-listener',
      script: './dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      log_type: 'json',
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 10000,
      shutdown_with_message: true,
    },
  ],
};
