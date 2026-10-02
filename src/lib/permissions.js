export const ROLES = {
  admin: '본사 관리자',
  manager: '매장 관리자',
  staff: '매장 직원',
  online: '온라인 운영자',
  viewer: '조회 전용',
};

const ALL = Object.keys(ROLES);

/** 권한 → 허용 역할. 새 기능은 여기에 먼저 정의하고, 화면과 서버(라우트) 양쪽에서 같은 이름을 쓴다. */
const PERMISSIONS = {
  view: ALL,
  'product.write': ['admin', 'manager'],
  'product.import': ['admin', 'manager'],
  'stock.in': ['admin', 'manager', 'staff'],
  'stock.out': ['admin', 'manager', 'staff'],
  'stock.adjust': ['admin', 'manager'],
  'order.import': ['admin', 'manager', 'online'],
  'order.ship': ['admin', 'manager', 'online'],
  'order.return': ['admin', 'manager', 'online'],
  'order.match': ['admin', 'manager', 'online'],
  'user.manage': ['admin'],
};

export function can(role, permission) {
  const allowed = PERMISSIONS[permission];
  return Boolean(allowed && allowed.includes(role));
}

export const permissionNames = Object.keys(PERMISSIONS);
