# 운영 가이드

## 1. 서버에 올리기 (Ubuntu VPS 예시)

```sh
# Node.js 22 설치 후
sudo useradd -r -m -s /usr/sbin/nologin stocksync
sudo -u stocksync git clone <저장소 주소> /opt/stocksync
cd /opt/stocksync && sudo -u stocksync npm ci --omit=dev
sudo -u stocksync DB_PATH=/var/lib/stocksync/stocksync.db npm run create-admin -- admin "관리자"
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
- 관리자 비밀번호를 잊었다면 `npm run create-admin` 으로 새 관리자를 만든 뒤 기존 계정 비밀번호를 재설정.

## 7. 알아 둘 점

- **동시 사용:** 쓰기는 SQLite 트랜잭션으로 직렬 처리되므로 매장 1개·직원 몇 명 규모에서 충분합니다. 매장이 여러 곳으로 늘면 PostgreSQL 전환을 검토하세요 (재고 로직은 `src/lib/inventory.js` 에 모여 있습니다).
- **재고 차감 시점:** 출고확정입니다. 주문을 가져온 뒤 출고 전에 매장에서 같은 상품이 팔리면 출고 때 재고가 부족할 수 있습니다. “오버셀 위험” 필터(`/products?filter=risk`)와 대시보드 숫자를 수시로 확인하세요.
