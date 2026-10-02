import { dashboardStats } from '../lib/products.js';

export function registerDashboard(app, { db, guard }) {
  app.get('/', guard('view'), (req, res) => {
    res.render('dashboard', { title: '대시보드', stats: dashboardStats(db) });
  });
}
