# 운영 가이드

## 0. jejubaseball.com 에 연결하기 (빠른 길)

> 먼저 정하세요: **`jejubaseball.com` 루트 주소를 재고 시스템 전용으로 쓰는가?** 이미 쇼핑몰·홈페이지가 그 주소에 있다면 통째로 바꾸면 안 됩니다. 그때는 `stock.jejubaseball.com` 같은 하위 주소를 쓰세요(아래 `DOMAIN=` 값만 바꾸면 됩니다). 재고 시스템은 내부 업무용이라 별도 주소가 더 안전합니다.

1. **DNS(도메인 업체 화면):** 쓸 주소(`jejubaseball.com` 또는 `stock.jejubaseball.com`)의 **A 레코드**를 서버의 공인 IP로 설정. IPv6(AAAA)가 이미 다른 곳을 가리키면 함께 정리. 반영에는 몇 분~몇 시간이 걸립니다.
2. **서버(Hostinger VPS 등, root):** 아래 한 줄. 코드 내려받기, Node 22(없으면 별도 설치), 서비스 등록, HTTPS 인증서 자동 발급(Caddy), 매일 백업까지 합니다.
   ```sh
   git clone --depth 1 https://github.com/domminc/stocksync.git /opt/stocksync   # 처음 한 번
   cd /opt/stocksync && DOMAIN=jejubaseball.com PASSWORD_MIN_LENGTH=10 bash deploy/setup.sh
   ```
   - 서버에 이미 nginx/apache가 80·443 포트를 쓰고 있으면 Caddy를 설치하지 않고, 기존 웹 서버에 넣을 설정을 출력합니다(다른 사이트를 깨뜨리지 않기 위해).
   - 서버의 기존 Node는 건드리지 않습니다(필요하면 `/opt/node22`에 따로 설치).
3. **관리자 계정:** 스크립트가 마지막에 출력하는 `create-admin` 명령을 실행해 `jiny` 를 만들고 비밀번호를 직접 입력.
4. **방화벽:** 80, 443 포트 허용(Hostinger 방화벽 + `ufw` 둘 다 확인). `https://도메인` 접속.
5. **업데이트:** 같은 `DOMAIN=… bash deploy/setup.sh` 를 다시 실행(코드 갱신 + 재시작). 데이터(`/var/lib/stocksync`)는 그대로 유지.

HTTPS 운영 설정(`SECURE_COOKIE=1`, `TRUST_PROXY=1`)이 켜져 있으면 로그인 쿠키는 HTTPS 전용이고 브라우저가 항상 HTTPS로 접속하도록 HSTS가 함께 전송됩니다(하위 도메인에는 적용하지 않음).

### Cloudflare 를 쓸 때 (jejubaseball.com 이 Cloudflare 네임서버로 바뀐 경우)

1. **Cloudflare → DNS → Records → Add record:** 종류 `A`, 이름 `stock`(또는 `@`), IPv4 주소는 서버 공인 IP, 프록시 상태는 **DNS 전용(회색 구름)** 으로 시작.
   - 같은 이름의 기존 레코드가 있으면 덮어쓰지 말고 먼저 무엇을 가리키는지 확인(쇼핑몰이면 하위 주소 사용).
2. 서버에서 `CLOUDFLARE=1` 을 붙여 설치: `DOMAIN=stock.jejubaseball.com CLOUDFLARE=1 bash deploy/setup.sh`
   - Caddy 가 Cloudflare 의 접속자 IP(CF-Connecting-IP)를 믿고 앱에 전달합니다. 이게 없으면 모든 접속이 Cloudflare 서버 IP로 보여 로그인 잠금이 서로 영향을 줍니다.
3. `https://도메인` 이 열리면 **Cloudflare → SSL/TLS → Overview → `Full (strict)`** 로 설정한 뒤, 레코드를 **프록시됨(주황 구름)** 으로 바꿉니다.
   - `Flexible` 은 쓰지 마세요(HTTP→HTTPS 이동이 무한 반복됩니다).
   - 처음부터 주황 구름이면 인증서 발급이 실패할 수 있어 회색으로 시작합니다.
4. (선택) 서버 방화벽에서 80/443 을 Cloudflare IP 대역에서만 허용하면 Cloudflare 를 거치지 않은 직접 접속을 막을 수 있습니다.

## 1. 서버에 올리기 (수동 설치 설명)

```sh
# Node.js 22 설치 후
sudo useradd -r -m -s /usr/sbin/nologin stocksync
sudo -u stocksync git clone <저장소 주소> /opt/stocksync
cd /opt/stocksync && sudo -u stocksync npm ci --omit=dev
# 비밀번호는 프롬프트에 직접 입력합니다 (저장소·명령줄 기록에 남기지 않기 위해)
# 10자보다 짧은 비밀번호를 쓰려면 PASSWORD_MIN_LENGTH 를 함께 지정하고, 서비스 설정에도 같은 값을 넣으세요(아래 Environment).
sudo -u stocksync env DB_PATH=/var/lib/stocksync/stocksync.db PASSWORD_MIN_LENGTH=10 npm run create-admin -- jiny "지니"
```

`/etc/systemd/system/stocksync.service`

```ini
[Unit]
Description=StockSync
After=network.target

[Service]
User=stocksync
WorkingDirectory=/opt/stocksync
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=3000
Environment=DB_PATH=/var/lib/stocksync/stocksync.db
Environment=SECURE_COOKIE=1
Environment=TRUST_PROXY=1
Environment=PASSWORD_MIN_LENGTH=10
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/server.js
Restart=on-failure
StateDirectory=stocksync
# 보안 강화 (선택)
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/stocksync

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now stocksync
```

## 2. HTTPS (필수)

로그인 정보가 오가므로 반드시 HTTPS 뒤에서 운영합니다. 앱은 `127.0.0.1`에서만 받고, nginx/Caddy가 인증서와 프록시를 맡습니다.

Caddy 예시 (인증서 자동 발급):

```text
stock.example.com {
    request_body { max_size 100MB }
    reverse_proxy 127.0.0.1:3000
}
```

nginx를 쓴다면 `client_max_body_size 100m;` 과 `proxy_set_header X-Forwarded-For $remote_addr;`, `X-Forwarded-Proto` 를 설정하세요.
`SECURE_COOKIE=1`, `TRUST_PROXY=1` 을 켜야 쿠키가 HTTPS 전용이 되고 로그인 잠금이 실제 접속 IP 기준으로 동작합니다.

## 3. 백업 (재고 원장이 곧 자산입니다)

```sh
# 매일 03:10 백업, 14개 보관 (crontab -e, stocksync 사용자)
10 3 * * * cd /opt/stocksync && DB_PATH=/var/lib/stocksync/stocksync.db BACKUP_DIR=/var/backups/stocksync npm run backup --silent
```

- `npm run backup` 은 서비스를 멈추지 않고 일관된 복사본(`VACUUM INTO`)을 만듭니다.
- 백업 파일은 **다른 서버/저장소로도 복사**하세요 (서버 디스크 장애 대비).
- **복구 연습을 한 번 해 두세요:** 서비스 중지 → 백업 파일을 `DB_PATH` 로 복사(기존 `-wal`, `-shm` 파일은 삭제) → 서비스 시작.

## 4. 업데이트

```sh
cd /opt/stocksync && sudo -u stocksync git pull && sudo -u stocksync npm ci --omit=dev
npm test                     # (가능하면) 먼저 확인
sudo systemctl restart stocksync
```

DB 구조 변경은 `migrations/` 의 새 SQL 이 시작할 때 자동 적용됩니다. **기존 마이그레이션 파일은 수정하지 마세요.**

## 5. 도입(오픈) 체크리스트

1. **상품 목록 만들기:** 상품명·옵션(가능하면 상품코드, 있으면 현재고)이 있는 CSV를 **상품 가져오기**로 올립니다. 바코드 열은 비워 두면 자동 발급됩니다. 오류 보고서의 행을 고쳐 다시 올려도 안전합니다(같은 상품코드, 또는 코드가 없으면 같은 상품명+옵션은 새로 발급하지 않음).
2. **라벨 인쇄·부착:** `라벨 인쇄` 에서 “라벨 미출력만”을 인쇄해 상품에 붙입니다. 라벨 프린터는 브라우저 인쇄 창에서 용지 크기를 라벨에 맞추고 여백을 없음으로 한 번 설정합니다. 처음 도입 때는 **현재고가 있는 상품부터** 붙이세요.
3. 실제 스캐너로 입고·출고 스캔을 직원과 함께 연습합니다 (스캐너가 Enter 를 자동 전송하도록 설정).
4. 사용자 계정을 역할별로 만들고, 처음 로그인 후 **비밀번호 변경**을 안내합니다.
5. **전환 기준 시각 정하기:** 기준 시각 이후의 주문부터 가져옵니다. 이미 출고된 주문은 상태가 “배송중/구매확정”이면 자동으로 “외부 출고됨(재고 미반영)” 처리됩니다.
6. 오픈 첫날은 아침에 재고 CSV 내려받기 → 마감 때 다시 내려받아 원장과 대조.

## 6. 장애·문의 시 확인

- 화면에서 “서버에서 오류가 발생했습니다” → `journalctl -u stocksync -n 100` 의 `[오류]` 줄.
- 로그인이 잠겼다면 15분 뒤 자동 해제됩니다. 급하면 DB에서 `DELETE FROM login_attempts;` 를 실행하세요 (서비스 재시작으로는 풀리지 않습니다).
- 일반 계정의 비밀번호는 관리자가 `계정 관리`에서 초기화합니다. 관리자(jiny)가 비밀번호를 잊었다면 서버에서 `DB_PATH=/var/lib/stocksync/stocksync.db npm run reset-password -- jiny` 로 임시 비밀번호를 받고, 로그인해서 새로 정합니다.

## 7. 알아 둘 점

- **동시 사용:** 쓰기는 SQLite 트랜잭션으로 직렬 처리되므로 매장 1개·직원 몇 명 규모에서 충분합니다. 매장이 여러 곳으로 늘면 PostgreSQL 전환을 검토하세요 (재고 로직은 `src/lib/inventory.js` 에 모여 있습니다).
- **재고 차감 시점:** 출고확정입니다. 주문을 가져온 뒤 출고 전에 매장에서 같은 상품이 팔리면 출고 때 재고가 부족할 수 있습니다. “오버셀 위험” 필터(`/products?filter=risk`)와 대시보드 숫자를 수시로 확인하세요.
