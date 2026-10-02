#!/usr/bin/env bash
# StockSync 서버 설치·업데이트 (Ubuntu 22.04 이상, root 로 실행). 여러 번 실행해도 안전하다.
#
#   DOMAIN=jejubaseball.com bash deploy/setup.sh
#
# 하는 일: Node 22 확인(없으면 /opt/node22 에 별도 설치, 서버의 기존 Node 는 건드리지 않음) → 서비스 사용자 →
#          코드 내려받기/갱신 → 의존성 설치 → systemd 서비스 → HTTPS 리버스 프록시(Caddy, 자동 인증서) → 매일 백업.
# 하지 않는 일: 관리자 계정 생성(비밀번호를 직접 입력해야 하므로 마지막에 명령을 안내), DNS 설정(도메인 업체에서 설정).
set -euo pipefail

DOMAIN="${DOMAIN:-}"
[ -n "$DOMAIN" ] || { echo "DOMAIN 을 지정하세요. 예: DOMAIN=jejubaseball.com bash deploy/setup.sh" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "root 로 실행하세요: sudo DOMAIN=$DOMAIN bash deploy/setup.sh" >&2; exit 1; }
case "$DOMAIN" in *[!a-zA-Z0-9.-]*|.*|*.|"") echo "도메인 형식이 올바르지 않습니다: $DOMAIN" >&2; exit 1 ;; esac

REPO="${REPO:-https://github.com/domminc/stocksync.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/stocksync}"
DATA_DIR="/var/lib/stocksync"
BACKUP_DIR="/var/backups/stocksync"
PORT="${PORT:-3000}"
PASSWORD_MIN_LENGTH="${PASSWORD_MIN_LENGTH:-10}"
NODE_VERSION="${NODE_VERSION:-22.22.0}"
WWW_REDIRECT="${WWW_REDIRECT:-0}"   # 1 이면 www.<도메인> 을 <도메인> 으로 보낸다
CLOUDFLARE="${CLOUDFLARE:-0}"       # 1 이면 Cloudflare(주황 구름) 뒤에서 접속자의 진짜 IP 를 사용한다

say() { printf '\n==> %s\n' "$*"; }

say "기본 도구 확인"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y curl git ca-certificates xz-utils gnupg >/dev/null

say "Node 22 확인"
NODE_BIN=""
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then
  NODE_BIN="$(command -v node)"
else
  arch="$(uname -m)"; case "$arch" in x86_64) narch=x64 ;; aarch64|arm64) narch=arm64 ;; *) echo "지원하지 않는 CPU: $arch" >&2; exit 1 ;; esac
  if [ ! -x /opt/node22/bin/node ]; then
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${narch}.tar.xz" -o /tmp/node22.tar.xz
    rm -rf /opt/node22 && mkdir -p /opt/node22 && tar -xJf /tmp/node22.tar.xz -C /opt/node22 --strip-components=1 && rm -f /tmp/node22.tar.xz
  fi
  NODE_BIN="/opt/node22/bin/node"
fi
NODE_DIR="$(dirname "$NODE_BIN")"
echo "Node: $NODE_BIN ($("$NODE_BIN" -v))"

say "서비스 사용자와 폴더"
id stocksync >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin stocksync
mkdir -p "$DATA_DIR" "$BACKUP_DIR"
chown stocksync:stocksync "$DATA_DIR" "$BACKUP_DIR"
chmod 750 "$DATA_DIR" "$BACKUP_DIR"

say "코드 내려받기/갱신 ($REPO · $BRANCH)"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
chown -R stocksync:stocksync "$APP_DIR"
runuser -u stocksync -- env PATH="$NODE_DIR:$PATH" bash -c "cd '$APP_DIR' && npm ci --omit=dev --no-audit --no-fund"

say "systemd 서비스"
cat > /etc/systemd/system/stocksync.service <<UNIT
[Unit]
Description=StockSync
After=network.target

[Service]
User=stocksync
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=$PORT
Environment=DB_PATH=$DATA_DIR/stocksync.db
Environment=SECURE_COOKIE=1
Environment=TRUST_PROXY=1
Environment=PASSWORD_MIN_LENGTH=$PASSWORD_MIN_LENGTH
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning src/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable stocksync >/dev/null
systemctl restart stocksync

say "서비스 응답 확인"
ok=0
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/login" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ "$ok" -eq 1 ] || { echo "서비스가 응답하지 않습니다: journalctl -u stocksync -n 50" >&2; exit 1; }
echo "앱이 127.0.0.1:$PORT 에서 실행 중입니다."

say "HTTPS 리버스 프록시"
LISTENERS="$(ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null || true)"
if echo "$LISTENERS" | grep -qE 'nginx|apache2|httpd'; then
  echo "이 서버는 이미 다른 웹 서버(nginx/apache)가 80/443 포트를 쓰고 있어 Caddy 를 설치하지 않았습니다."
  echo "기존 웹 서버에 아래 설정을 추가하세요 (server_name $DOMAIN, 인증서는 certbot 등으로 발급):"
  cat <<NGINX
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        client_max_body_size 100m;
    }
NGINX
else
  if ! command -v caddy >/dev/null 2>&1; then
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y >/dev/null && apt-get install -y caddy >/dev/null
  fi
  mkdir -p /etc/caddy/conf.d
  touch /etc/caddy/Caddyfile
  # 전역 설정(Cloudflare 신뢰 IP)은 Caddyfile 맨 앞에 있어야 하므로 import 줄을 맨 위에 둔다
  if ! grep -q 'import /etc/caddy/conf.d' /etc/caddy/Caddyfile; then
    sed -i '1i import /etc/caddy/conf.d/*.caddy\n' /etc/caddy/Caddyfile
  fi
  if [ "$CLOUDFLARE" = "1" ]; then
    CF_RANGES="$( { curl -fsS https://www.cloudflare.com/ips-v4; echo; curl -fsS https://www.cloudflare.com/ips-v6; } | tr '\n' ' ')"
    [ -n "${CF_RANGES// /}" ] || { echo "Cloudflare IP 목록을 가져오지 못했습니다." >&2; exit 1; }
    cat > /etc/caddy/conf.d/00-cloudflare.caddy <<CFG
{
    servers {
        trusted_proxies static $CF_RANGES
        client_ip_headers CF-Connecting-IP
    }
}
CFG
  else
    rm -f /etc/caddy/conf.d/00-cloudflare.caddy
  fi
  {
    echo "$DOMAIN {"
    echo "    encode gzip"
    echo "    request_body {"
    echo "        max_size 100MB"
    echo "    }"
    if [ "$CLOUDFLARE" = "1" ]; then
      echo "    reverse_proxy 127.0.0.1:$PORT {"
      echo "        header_up X-Forwarded-For {client_ip}"
      echo "    }"
    else
      echo "    reverse_proxy 127.0.0.1:$PORT"
    fi
    echo "}"
    if [ "$WWW_REDIRECT" = "1" ]; then
      echo "www.$DOMAIN {"
      echo "    redir https://$DOMAIN{uri} permanent"
      echo "}"
    fi
  } > /etc/caddy/conf.d/stocksync.caddy
  caddy validate --config /etc/caddy/Caddyfile >/dev/null
  systemctl enable caddy >/dev/null
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  echo "Caddy 설정 완료: https://$DOMAIN (DNS 가 이 서버를 가리키면 인증서가 자동으로 발급됩니다)"
fi

say "매일 백업 (03:10, 14개 보관)"
cat > /etc/cron.d/stocksync-backup <<CRON
10 3 * * * stocksync cd $APP_DIR && DB_PATH=$DATA_DIR/stocksync.db BACKUP_DIR=$BACKUP_DIR $NODE_BIN --disable-warning=ExperimentalWarning scripts/backup.js >/dev/null 2>&1
CRON
chmod 644 /etc/cron.d/stocksync-backup

cat <<DONE

==> 설치 완료. 남은 일
 1) 관리자 계정 만들기 (비밀번호는 프롬프트에 직접 입력):
      runuser -u stocksync -- env PATH="$NODE_DIR:\$PATH" DB_PATH=$DATA_DIR/stocksync.db PASSWORD_MIN_LENGTH=$PASSWORD_MIN_LENGTH \\
        bash -c "cd $APP_DIR && npm run create-admin -- jiny 지니"
 2) 도메인 업체(DNS)에서 $DOMAIN 의 A 레코드를 이 서버의 공인 IP 로 설정
      (이 서버의 IP: $(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || echo '확인 실패 - 호스팅 업체 화면에서 확인'))
 3) 방화벽에서 80, 443 포트 허용 → https://$DOMAIN 접속 확인
 업데이트: 같은 명령(DOMAIN=$DOMAIN bash deploy/setup.sh)을 다시 실행
DONE
