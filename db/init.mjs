import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, 'database.sqlite');
const dbDir  = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sub_packages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    price_pence     INTEGER NOT NULL DEFAULT 0,
    stripe_price_id TEXT    DEFAULT '',
    description     TEXT    DEFAULT '',
    features        TEXT    NOT NULL DEFAULT '[]',
    visible         INTEGER NOT NULL DEFAULT 1,
    popular         INTEGER NOT NULL DEFAULT 0,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS subscribers (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT    NOT NULL,
    email              TEXT    NOT NULL,
    package_id         INTEGER,
    package_name       TEXT    DEFAULT '',
    stripe_customer_id TEXT    DEFAULT '',
    stripe_sub_id      TEXT    DEFAULT '',
    status             TEXT    DEFAULT 'Active',
    start_date         TEXT    DEFAULT (datetime('now')),
    next_payment_date  TEXT    DEFAULT '',
    created_at         TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payment_history (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id     INTEGER DEFAULT 0,
    customer_name     TEXT    DEFAULT '',
    customer_email    TEXT    DEFAULT '',
    package_name      TEXT    DEFAULT '',
    amount_pence      INTEGER DEFAULT 0,
    currency          TEXT    DEFAULT 'gbp',
    status            TEXT    DEFAULT 'Paid',
    stripe_payment_id TEXT    DEFAULT '',
    created_at        TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS packages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    price      INTEGER NOT NULL DEFAULT 0,
    about      TEXT    NOT NULL DEFAULT '',
    visible    INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS addons (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    price      INTEGER NOT NULL DEFAULT 0,
    visible    INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    email         TEXT    NOT NULL,
    phone         TEXT    DEFAULT '',
    vehicle_make  TEXT    DEFAULT '',
    vehicle_model TEXT    DEFAULT '',
    tier          TEXT    DEFAULT '',
    frequency     INTEGER DEFAULT 0,
    addons        TEXT    DEFAULT '[]',
    preferred_date TEXT   DEFAULT '',
    status        TEXT    DEFAULT 'Pending',
    notes         TEXT    DEFAULT '',
    created_at    TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    phone      TEXT DEFAULT '',
    message    TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS media (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL DEFAULT 'photo',
    filename   TEXT DEFAULT '',
    url        TEXT DEFAULT '',
    label      TEXT DEFAULT '',
    vehicle    TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    alt_text   TEXT DEFAULT '',
    section    TEXT DEFAULT '',
    file_size  INTEGER DEFAULT 0,
    width      INTEGER DEFAULT 0,
    height     INTEGER DEFAULT 0,
    caption    TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS slides (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    headline        TEXT    DEFAULT '',
    sub             TEXT    DEFAULT '',
    cta1_text       TEXT    DEFAULT '',
    cta1_link       TEXT    DEFAULT '',
    cta2_text       TEXT    DEFAULT '',
    cta2_link       TEXT    DEFAULT '',
    image_url       TEXT    DEFAULT '',
    video_url       TEXT    DEFAULT '',
    overlay_color   TEXT    DEFAULT '#000000',
    overlay_opacity REAL    DEFAULT 0.5,
    sort_order      INTEGER DEFAULT 0,
    visible         INTEGER DEFAULT 1,
    created_at      TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    username           TEXT    UNIQUE NOT NULL,
    email              TEXT    NOT NULL DEFAULT '',
    password_hash      TEXT    NOT NULL,
    role               TEXT    NOT NULL DEFAULT 'super_admin',
    totp_secret        TEXT    DEFAULT '',
    totp_enabled       INTEGER DEFAULT 0,
    failed_login_count INTEGER DEFAULT 0,
    lockout_until      TEXT    DEFAULT '',
    last_login         TEXT    DEFAULT '',
    created_at         TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS security_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT    NOT NULL,
    ip         TEXT    DEFAULT '',
    username   TEXT    DEFAULT '',
    details    TEXT    DEFAULT '',
    created_at TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS consent_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_email TEXT    NOT NULL DEFAULT '',
    consent_type   TEXT    NOT NULL,
    given          INTEGER NOT NULL DEFAULT 0,
    source         TEXT    NOT NULL DEFAULT '',
    created_at     TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS breach_log (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    discovered_at        TEXT    NOT NULL,
    nature               TEXT    NOT NULL DEFAULT '',
    data_categories      TEXT    NOT NULL DEFAULT '',
    individuals_affected INTEGER NOT NULL DEFAULT 0,
    actions_taken        TEXT    NOT NULL DEFAULT '',
    ico_notified         INTEGER NOT NULL DEFAULT 0,
    reporter             TEXT    NOT NULL DEFAULT '',
    created_at           TEXT    DEFAULT (datetime('now'))
  );
`);

/* ── Migrate media columns (safe — will no-op if already present) ── */
const mediaColMigrations = [
  "ALTER TABLE media ADD COLUMN alt_text TEXT DEFAULT ''",
  "ALTER TABLE media ADD COLUMN section TEXT DEFAULT ''",
  "ALTER TABLE media ADD COLUMN file_size INTEGER DEFAULT 0",
  "ALTER TABLE media ADD COLUMN width INTEGER DEFAULT 0",
  "ALTER TABLE media ADD COLUMN height INTEGER DEFAULT 0",
  "ALTER TABLE media ADD COLUMN caption TEXT DEFAULT ''",
];
for (const sql of mediaColMigrations) { try { db.exec(sql); } catch {} }

/* ── Migrate: old packages table used a tier+freq grid; rebuild as a flexible list ── */
const pkgTableInfo = db.prepare("PRAGMA table_info(packages)").all().map(c => c.name);
if (!pkgTableInfo.includes('name')) {
  db.exec('DROP TABLE IF EXISTS packages');
  db.exec(`CREATE TABLE packages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    price      INTEGER NOT NULL DEFAULT 0,
    about      TEXT    NOT NULL DEFAULT '',
    visible    INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    DEFAULT (datetime('now'))
  )`);
}

/* ── Seed add-ons ── */
const addonCount = db.prepare('SELECT COUNT(*) as c FROM addons').get();
if (addonCount.c === 0) {
  const ins = db.prepare('INSERT INTO addons (name, price, sort_order) VALUES (?,?,?)');
  ins.run('Engine Bay Clean', 35, 0);
  ins.run('Odour Treatment', 20, 1);
  ins.run('Paint Correction', 80, 2);
  ins.run('Ceramic Top-Up', 45, 3);
}

/* ── Seed settings ── */
const defaults = {
  instagram_url: '#', facebook_url: '#', tiktok_url: '#',
  twitter_url: '#', youtube_url: '#',
  phone: '07500 000000',
  email: 'info@cleantorquedetailing.co.uk',
  address: 'Clean Torque Detailing, United Kingdom',
  admin_username: 'admin',
  admin_password: 'ctd2025',
  hero_tag: 'Vehicle Appearance Specialists',
  hero_headline: 'LUXURY<br>DETAILING,<br><em>TAILORED</em><br>TO YOU',
  hero_sub: 'Premium monthly wash plans to keep your vehicle showroom-ready. Trusted by car enthusiasts across the UK.',
  hero_cta1_text: 'View Packages',
  hero_cta1_link: '#packages',
  hero_cta2_text: 'Book a Session',
  hero_cta2_link: '#booking',
  hero_bg_url: 'https://images.unsplash.com/photo-1618843479313-40f8afb4b4d8?w=1600&q=80',
  hero_tag_color: '#1A6FFF',
  hero_headline_color: '#F5F5F5',
  hero_accent_color: '#6B6B6B',
  hero_sub_color: '#C4C4C4',
  hero_show: '1',
  hero_padding_top: '80',
  hero_overlay_opacity: '0.55',
  // Slideshow settings
  slideshow_transition: 'fade',
  slideshow_interval: '5',
  slideshow_autoplay: '1',
  slideshow_dots: '1',
  slideshow_arrows: '1',
  slideshow_enabled: '0',
  // Global typography & brand
  global_heading_font: 'Bebas Neue',
  global_body_font: 'DM Sans',
  global_brand_color: '#1A6FFF',
  global_body_color: '#F5F5F5',
  global_heading_color: '#F5F5F5',
  global_body_size: '16',
  global_body_line_height: '1.7',
  global_heading_letter_spacing: '0.06',
  global_btn_radius: '6',
  // Navbar section
  nav_show: '1',
  nav_logo_text: 'CLEAN TORQUE',
  nav_logo_sub: 'Detailing',
  nav_cta_text: 'Book Now',
  nav_cta_link: '#booking',
  nav_bg_color: 'rgba(13,13,13,0.92)',
  // Stats section
  stats_show: '1',
  stat1_num: '500+',
  stat1_label: 'Vehicles Detailed',
  stat2_num: '4.9★',
  stat2_label: 'Average Rating',
  stat3_num: '3',
  stat3_label: 'Subscription Tiers',
  stat4_num: '24h',
  stat4_label: 'Booking Response',
  stats_num_color: '#1A6FFF',
  stats_label_color: '#6B6B6B',
  stats_bg_color: '',
  stats_padding_top: '36',
  stats_padding_bottom: '36',
  // Packages section
  packages_show: '1',
  packages_title: 'OUR PACKAGES',
  packages_sub: 'Choose the package that fits your vehicle',
  packages_title_color: '#F5F5F5',
  packages_bg_color: '',
  packages_padding_top: '100',
  packages_padding_bottom: '100',
  // Booking section
  booking_show: '1',
  booking_title: 'BUILD YOUR PLAN',
  booking_sub: "Select your package, choose your frequency, add any extras, and tell us about your vehicle. We'll confirm within 24 hours.",
  booking_title_color: '#F5F5F5',
  booking_bg_color: '',
  booking_padding_top: '100',
  booking_padding_bottom: '100',
  // Gallery section
  gallery_show: '1',
  gallery_title: 'THE RESULTS SPEAK',
  gallery_sub: 'Before & after — real vehicles, real transformations',
  gallery_title_color: '#F5F5F5',
  gallery_bg_color: '',
  gallery_padding_top: '100',
  gallery_padding_bottom: '100',
  // Contact section
  contact_show: '1',
  contact_title: 'GET IN TOUCH',
  contact_sub: "Have a question or want to discuss a bespoke package? We're happy to help — reach out through any channel below.",
  contact_title_color: '#F5F5F5',
  contact_bg_color: '',
  contact_padding_top: '100',
  contact_padding_bottom: '100',
  // Footer section
  footer_show: '1',
  footer_tagline: 'Premium vehicle appearance specialists. Subscription-based detailing packages for discerning drivers.',
  footer_copyright: '© 2025 Clean Torque Detailing. All rights reserved.',
  footer_bg_color: '',
};
const settingIns = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)');
for (const [k, v] of Object.entries(defaults)) settingIns.run(k, v);

/* ── Seed subscription packages ── */
const subPkgCount = db.prepare('SELECT COUNT(*) as c FROM sub_packages').get();
if (subPkgCount.c === 0) {
  const ins = db.prepare('INSERT INTO sub_packages (name, price_pence, description, features, visible, popular, sort_order) VALUES (?,?,?,?,?,?,?)');
  ins.run('Essential', 2900, 'Perfect for keeping your vehicle clean and presentable every month.',
    JSON.stringify(['Monthly exterior hand wash & rinse','Wheel clean & tyre dressing','Window polish (exterior)','Air freshener treatment','Priority booking slot']),
    1, 0, 1);
  ins.run('Premium', 4900, 'Our most popular plan — a full detail package every month.',
    JSON.stringify(['Everything in Essential','Interior vacuum & dashboard wipe','Machine polish (light swirls)','Paint sealant application','Leather conditioning','UV protectant on plastics']),
    1, 1, 2);
  ins.run('VIP', 8900, 'Concierge-level care for those who accept nothing less than perfect.',
    JSON.stringify(['Everything in Premium','Full ceramic coat top-up','Paint correction included','Engine bay detail','Concierge pickup & return','Monthly inspection report','Dedicated detailer assigned']),
    1, 0, 3);
}

/* ── Migrate admin credentials into admin_users (runs once) ── */
const adminUserCount = db.prepare('SELECT COUNT(*) as c FROM admin_users').get();
if (adminUserCount.c === 0) {
  const storedUsername = db.prepare("SELECT value FROM settings WHERE key='admin_username'").get()?.value || 'admin';
  const storedPassword = db.prepare("SELECT value FROM settings WHERE key='admin_password'").get()?.value || 'ctd2025';
  const passwordHash = bcrypt.hashSync(storedPassword, 12);
  db.prepare('INSERT INTO admin_users (username, password_hash, role) VALUES (?,?,?)').run(storedUsername, passwordHash, 'super_admin');
  console.log('✓ Admin user migrated — plaintext credential in settings is now superseded by admin_users table');
}

/* ── Seed payment settings ── */
const paymentDefaults = {
  bank_holder_name:       '',
  bank_sort_code:         '',
  bank_account_number:    '',
  bank_name:              '',
  bank_payout_schedule:   'weekly',
  bank_next_payout:       '',
  payment_notify_email:   '',
  payment_notify_from:    '',
  payment_notify_new_sub: '1',
  payment_notify_failed:  '1',
};
for (const [k, v] of Object.entries(paymentDefaults)) settingIns.run(k, v);

/* ── Migrations: add columns if they don't exist ── */
const bookingCols = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name);
if (!bookingCols.includes('marketing_consent'))    db.exec("ALTER TABLE bookings ADD COLUMN marketing_consent INTEGER DEFAULT 0");
if (!bookingCols.includes('marketing_consent_at')) db.exec("ALTER TABLE bookings ADD COLUMN marketing_consent_at TEXT DEFAULT ''");

const contactCols = db.prepare("PRAGMA table_info(contacts)").all().map(c => c.name);
if (!contactCols.includes('marketing_consent'))    db.exec("ALTER TABLE contacts ADD COLUMN marketing_consent INTEGER DEFAULT 0");
if (!contactCols.includes('marketing_consent_at')) db.exec("ALTER TABLE contacts ADD COLUMN marketing_consent_at TEXT DEFAULT ''");
