# QuizBot Deployment Guide (PM2 + Nginx)

## Automated VPS Deployment

### Prerequisites
- Fresh Ubuntu 22.04/24.04 VPS (2GB+ RAM)
- Domain name pointed to VPS IP
- Neon PostgreSQL project created
- Neon Object Storage enabled

### Quick Deploy

```bash
# 1. Upload project to VPS
scp -r . root@your-vps-ip:/tmp/quizbot

# 2. Run deployment script
ssh root@your-vps-ip
cd /tmp/quizbot
chmod +x deploy.sh
sudo bash deploy.sh yourdomain.com
```

### What the script does:
1. ✅ Installs Node.js 20, Nginx, Certbot, PostgreSQL client, **PM2**
2. ✅ Creates `quizbot` system user
3. ✅ Sets up project in `/opt/quizbot`
4. ✅ Installs dependencies & builds React client
5. ✅ Runs Prisma migrations
6. ✅ Creates PM2 ecosystem config with auto-restart, logging, memory limits
7. ✅ Configures Nginx with SSL (Let's Encrypt)
8. ✅ Configures PM2 startup on boot
9. ✅ Configures UFW firewall
10. ✅ Starts all services

### Post-deployment
```bash
# 1. Edit environment with your Neon credentials
nano /opt/quizbot/server/.env

# 2. Restart bot
sudo -u quizbot pm2 restart quizbot

# 3. Follow logs & scan WhatsApp QR
sudo -u quizbot pm2 logs quizbot -f
```

---

## PM2 Commands Reference

```bash
# Status & monitoring
sudo -u quizbot pm2 status              # List processes
sudo -u quizbot pm2 monit               # Live monitoring UI
sudo -u quizbot pm2 show quizbot        # Detailed process info

# Logs
sudo -u quizbot pm2 logs quizbot        # Show recent logs
sudo -u quizbot pm2 logs quizbot -f     # Follow logs (live)
sudo -u quizbot pm2 logs quizbot --err  # Error logs only

# Process control
sudo -u quizbot pm2 restart quizbot     # Restart
sudo -u quizbot pm2 stop quizbot        # Stop
sudo -u quizbot pm2 start quizbot       # Start
sudo -u quizbot pm2 delete quizbot      # Remove from PM2

# Reload config
sudo -u quizbot pm2 reload ecosystem.config.js  # Reload config

# Persistence
sudo -u quizbot pm2 save                # Save current process list
sudo -u quizbot pm2 resurrect           # Restore saved processes
```

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | Neon PostgreSQL connection string |
| `ADMIN_PASSWORD` | ✅ | Auto-generated, change if needed |
| `AUTH_SECRET` | ✅ | Auto-generated, change if needed |
| `CLIENT_ORIGIN` | ✅ | `https://yourdomain.com` |
| `MARZPAY_API_KEY` | ⚠️ | For payments |
| `MARZPAY_API_SECRET` | ⚠️ | For payments |
| `MARZPAY_WEBHOOK_SECRET` | ⚠️ | For webhook verification |
| `PUBLIC_URL` | ⚠️ | `https://yourdomain.com` |
| `AWS_ENDPOINT_URL_S3` | ✅ | Neon Object Storage endpoint |
| `AWS_ACCESS_KEY_ID` | ✅ | Neon Storage access key |
| `AWS_SECRET_ACCESS_KEY` | ✅ | Neon Storage secret key |
| `AWS_REGION` | ✅ | `us-east-2` |

---

## File Structure After Deploy

```
/opt/quizbot/
├── server/
│   ├── src/index.js          # Main entry
│   ├── src/whatsapp/bot.js   # WhatsApp bot
│   ├── prisma/schema.prisma  # DB schema
│   ├── .env                  # Environment (SECRET, chmod 600)
│   └── node_modules/
├── client/dist/              # Built React app
├── data/
│   ├── uploads/              # Local file storage
│   └── sessions/             # WhatsApp auth sessions
├── logs/                     # PM2 logs (error.log, out.log, combined.log)
├── ecosystem.config.js       # PM2 config
└── deploy.sh                 # This deployment script
```

---

## Troubleshooting

### Bot won't connect to WhatsApp
```bash
# Clear session & restart
rm -rf /opt/quizbot/data/sessions/*
sudo -u quizbot pm2 restart quizbot
# Scan new QR from logs
```

### SSL certificate issues
```bash
# Manual renewal
certbot certonly --nginx -d yourdomain.com
systemctl reload nginx
```

### Database connection failed
- Verify `DATABASE_URL` in `/opt/quizbot/server/.env`
- Check Neon project is active (not paused)
- Ensure IP allowlist includes VPS IP (or disable)

### Port 4000 already in use
```bash
lsof -i :4000
kill -9 <PID>
```

### PM2 not starting on boot
```bash
sudo -u quizbot pm2 startup systemd -u quizbot --hp /opt/quizbot
sudo -u quizbot pm2 save
```

---

## Security Notes

- `.env` file is `chmod 600` (owner read-only)
- PM2 runs as non-root `quizbot` user
- Nginx enforces HTTPS with security headers
- UFW allows only 22, 80, 443
- WhatsApp sessions stored locally (not in DB)
- Rate limiting on API endpoints via Nginx
- PM2 auto-restarts on crash, memory limit 500MB