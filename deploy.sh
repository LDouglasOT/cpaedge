#!/bin/bash
set -euo pipefail

# =============================================================================
# QuizBot Auto-Deployment Script for Fresh Ubuntu VPS
# =============================================================================
# Usage: sudo bash deploy.sh yourdomain.com
# =============================================================================

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "Usage: sudo bash deploy.sh yourdomain.com"
  exit 1
fi

APP_DIR="/opt/quizbot"
APP_USER="quizbot"
NODE_VERSION="20"
DB_NAME="quizbot"
DB_USER="quizbot"
DB_PASS=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-25)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; exit 1; }

# -----------------------------------------------------------------------------
# Check root
# -----------------------------------------------------------------------------
[[ $EUID -eq 0 ]] || error "Run as root: sudo bash deploy.sh yourdomain.com"

# -----------------------------------------------------------------------------
# Update system
# -----------------------------------------------------------------------------
log "Updating system packages..."
apt-get update && apt-get upgrade -y

# -----------------------------------------------------------------------------
# Install dependencies
# -----------------------------------------------------------------------------
log "Installing Node.js ${NODE_VERSION}..."
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
apt-get install -y nodejs nginx certbot python3-certbot-nginx postgresql-client git ufw

# Install PM2 globally
log "Installing PM2..."
npm install -g pm2

# -----------------------------------------------------------------------------
# Create app user
# -----------------------------------------------------------------------------
log "Creating app user..."
id -u "$APP_USER" &>/dev/null || useradd -r -m -d "$APP_DIR" -s /bin/bash "$APP_USER"

# Setup PM2 startup for the app user
sudo -u "$APP_USER" pm2 startup systemd -u "$APP_USER" --hp "$APP_DIR" || true

# -----------------------------------------------------------------------------
# Clone/copy project
# -----------------------------------------------------------------------------
log "Setting up project directory..."
mkdir -p "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# If running from repo, copy files; otherwise expect them to be placed
if [[ -d "/tmp/quizbot" ]]; then
  cp -r /tmp/quizbot/* "$APP_DIR/"
else
  warn "Project files not found in /tmp/quizbot. Place your project files in $APP_DIR before continuing."
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# -----------------------------------------------------------------------------
# Install server dependencies
# -----------------------------------------------------------------------------
log "Installing server dependencies..."
cd "$APP_DIR/server"
sudo -u "$APP_USER" npm ci --production

# -----------------------------------------------------------------------------
# Install client dependencies & build
# -----------------------------------------------------------------------------
log "Building client..."
cd "$APP_DIR/client"
sudo -u "$APP_USER" npm ci
sudo -u "$APP_USER" npm run build

# -----------------------------------------------------------------------------
# Setup PostgreSQL (using Neon - just verify connection)
# -----------------------------------------------------------------------------
log "Database: Using Neon PostgreSQL (external)..."
# Ensure DATABASE_URL is set in .env

# -----------------------------------------------------------------------------
# Create environment file
# -----------------------------------------------------------------------------
log "Creating .env file..."
cat > "$APP_DIR/server/.env" <<EOF
# ---- Server ----
PORT=4000
ADMIN_PASSWORD=$(openssl rand -base64 16 | tr -d "=+/" | cut -c1-16)
AUTH_SECRET=$(openssl rand -base64 32)
DATA_DIR=$APP_DIR/data
CLIENT_ORIGIN=https://$DOMAIN

# ---- MarzPay ----
PAYMENT_PROVIDER=marzpay
MARZPAY_API_KEY=
MARZPAY_API_SECRET=
MARZPAY_WEBHOOK_SECRET=
PUBLIC_URL=https://$DOMAIN

# ---- Neon Object Storage (S3-compatible) ----
AWS_REGION=us-east-2
AWS_ENDPOINT_URL_S3=https://br-odd-fog-bd2gd6jh.storage.c-8.us-east-2.aws.neon.tech
AWS_ACCESS_KEY_ID=nak_live_e25ccdca30e14da8a7c2f8e0a04ccf08
AWS_SECRET_ACCESS_KEY=nsk_live_ef0b31c3a90ed11f79c971c33b0c5a53a20256d07628891cd995cd6dfd148ca6

# ---- Database (Neon Postgres) ----
# REPLACE WITH YOUR NEON CONNECTION STRING:
DATABASE_URL=postgresql://neondb_owner:PASSWORD@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require
EOF

chown "$APP_USER:$APP_USER" "$APP_DIR/server/.env"
chmod 600 "$APP_DIR/server/.env"

warn "IMPORTANT: Edit $APP_DIR/server/.env and set your NEON DATABASE_URL"

# -----------------------------------------------------------------------------
# Create data directories
# -----------------------------------------------------------------------------
log "Creating data directories..."
mkdir -p "$APP_DIR/data/uploads" "$APP_DIR/data/sessions"
chown -R "$APP_USER:$APP_USER" "$APP_DIR/data"

# -----------------------------------------------------------------------------
# Run database migrations
# -----------------------------------------------------------------------------
log "Running database migrations..."
cd "$APP_DIR/server"
sudo -u "$APP_USER" npx prisma migrate deploy || warn "Migration failed - check DATABASE_URL in .env"

# -----------------------------------------------------------------------------
# Create PM2 ecosystem config
# -----------------------------------------------------------------------------
log "Creating PM2 ecosystem config..."
cat > "$APP_DIR/ecosystem.config.js" <<EOF
module.exports = {
  apps: [{
    name: 'quizbot',
    script: 'src/index.js',
    cwd: '$APP_DIR/server',
    env: {
      NODE_ENV: 'production',
      PORT: 4000
    },
    env_file: '$APP_DIR/server/.env',
    interpreter: 'node',
    interpreter_args: '--disable-warning=ExperimentalWarning',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '500M',
    restart_delay: 5000,
    error_file: '$APP_DIR/logs/error.log',
    out_file: '$APP_DIR/logs/out.log',
    log_file: '$APP_DIR/logs/combined.log',
    time: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000
  }]
};
EOF

mkdir -p "$APP_DIR/logs"
chown -R "$APP_USER:$APP_USER" "$APP_DIR/logs" "$APP_DIR/ecosystem.config.js"

# -----------------------------------------------------------------------------
# Configure Nginx
# -----------------------------------------------------------------------------
log "Configuring Nginx..."
cat > /etc/nginx/sites-available/quizbot <<EOF
# Redirect HTTP to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://\$server_name\$request_uri;
    }
}

# HTTPS Server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN www.$DOMAIN;

    # SSL certificates (will be added by certbot)
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";
    add_header X-XSS-Protection "1; mode=block";
    add_header Referrer-Policy "strict-origin-when-cross-origin";

    # Client (React) - served by Node for SPA routing
    location / {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # API routes
    location /api/ {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # WebSocket for WhatsApp bot (if needed)
    location /socket.io/ {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400;
    }

    # Static assets caching
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        proxy_pass http://localhost:4000;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
EOF

ln -sf /etc/nginx/sites-available/quizbot /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Test nginx config
nginx -t || error "Nginx configuration test failed"

# -----------------------------------------------------------------------------
# Get SSL certificate
# -----------------------------------------------------------------------------
log "Obtaining SSL certificate from Let's Encrypt..."
certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos --email "admin@$DOMAIN" --redirect || warn "Certbot failed - run manually: certbot --nginx -d $DOMAIN"

# -----------------------------------------------------------------------------
# Start PM2 service
# -----------------------------------------------------------------------------
log "Starting PM2 service..."
cd "$APP_DIR"
sudo -u "$APP_USER" pm2 start ecosystem.config.js
sudo -u "$APP_USER" pm2 save

# -----------------------------------------------------------------------------
# Configure firewall
# -----------------------------------------------------------------------------
log "Configuring firewall..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# -----------------------------------------------------------------------------
# Start services
# -----------------------------------------------------------------------------
log "Starting services..."
systemctl restart nginx

# -----------------------------------------------------------------------------
# Final status
# -----------------------------------------------------------------------------
sleep 3

echo ""
echo "=========================================="
echo -e "${GREEN}Deployment Complete!${NC}"
echo "=========================================="
echo ""
echo "Domain: https://$DOMAIN"
echo "API:    https://$DOMAIN/api"
echo ""
echo "PM2 status:"
sudo -u "$APP_USER" pm2 status
echo ""
echo "Next steps:"
echo "1. Edit $APP_DIR/server/.env and set your NEON DATABASE_URL"
echo "2. Add MARZPAY_API_KEY and MARZPAY_API_SECRET"
echo "3. Restart: sudo -u $APP_USER pm2 restart quizbot"
echo "4. Check logs: sudo -u $APP_USER pm2 logs quizbot"
echo "5. Scan WhatsApp QR code from logs"
echo ""
echo "Useful commands:"
echo "  sudo -u $APP_USER pm2 logs quizbot -f     # Follow logs"
echo "  sudo -u $APP_USER pm2 restart quizbot     # Restart bot"
echo "  sudo -u $APP_USER pm2 stop quizbot        # Stop bot"
echo "  sudo -u $APP_USER pm2 monit               # Monitoring UI"
echo "  nginx -t && systemctl reload nginx        # Reload nginx"
echo ""