    /* â”€â”€ Navbar scroll â”€â”€ */
    const navbar = document.getElementById('navbar');
    window.addEventListener('scroll', () => {
      navbar.classList.toggle('scrolled', window.scrollY > 40);
    }, { passive: true });

    /* â”€â”€ Mobile menu â”€â”€ */
    const hamburger = document.getElementById('hamburger');
    const mobileMenu = document.getElementById('mobileMenu');
    hamburger.addEventListener('click', () => {
      const open = mobileMenu.classList.toggle('open');
      hamburger.classList.toggle('open', open);
      hamburger.setAttribute('aria-expanded', open);
      document.body.style.overflow = open ? 'hidden' : '';
    });
    function closeMobile() {
      mobileMenu.classList.remove('open');
      hamburger.classList.remove('open');
      hamburger.setAttribute('aria-expanded', false);
      document.body.style.overflow = '';
    }

    /* â”€â”€ Fade-in on scroll â”€â”€ */
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); observer.unobserve(e.target); } });
    }, { threshold: 0.12 });
    document.querySelectorAll('.fade-in').forEach(el => observer.observe(el));
    function observeFadeIns() {
      document.querySelectorAll('.fade-in:not(.visible)').forEach(el => observer.observe(el));
    }

    function escHtml(str) {
      return String(str ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    }

    /* â”€â”€ Booking form â”€â”€ */
    let currentStep = 1;
    let selectedPkg = null;
    let selectedFreq = null;

    function updateStepIndicator(step) {
      document.querySelectorAll('.step-ind').forEach((el, i) => {
        const n = i + 1;
        const numEl = el.querySelector('.step-num');
        el.classList.toggle('active-step', n === step);
        numEl.classList.toggle('active', n === step);
        numEl.classList.toggle('done', n < step);
      });
    }

    function nextStep(to) {
      document.getElementById('step-' + currentStep).classList.remove('active');
      currentStep = to;
      document.getElementById('step-' + to).classList.add('active');
      updateStepIndicator(to);
      document.getElementById('booking').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function prevStep(to) { nextStep(to); }

    function prefillBooking(pkg, freq) {
      document.getElementById('booking').scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => {
        // Reset to step 1
        document.querySelectorAll('.form-step').forEach(s => s.classList.remove('active'));
        document.getElementById('step-1').classList.add('active');
        currentStep = 1;

        // Select package
        const pkgOpts = document.querySelectorAll('#pkg-options .form-option');
        pkgOpts.forEach(o => {
          const selected = o.dataset.value === pkg;
          o.classList.toggle('selected', selected);
          if (selected) o.querySelector('input').checked = true;
        });
        selectedPkg = pkg;
        updateStepIndicator(1);

        // Auto advance to step 2 and select freq
        setTimeout(() => {
          nextStep(2);
          const freqOpts = document.querySelectorAll('#freq-options .form-option');
          freqOpts.forEach(o => {
            const selected = o.dataset.value === freq;
            o.classList.toggle('selected', selected);
            if (selected) o.querySelector('input').checked = true;
          });
          selectedFreq = freq;
        }, 400);
      }, 600);
    }

    async function submitBooking() {
      const name  = document.getElementById('b-name').value.trim();
      const email = document.getElementById('b-email').value.trim();
      if (!name || !email) {
        alert('Please fill in your name and email address.');
        return;
      }
      const addons = [...document.querySelectorAll('.addon-option.selected')].map(o => o.dataset.value);
      const body = {
        name, email,
        phone:              document.getElementById('b-phone').value.trim(),
        vehicle_make:       document.getElementById('b-make').value.trim(),
        vehicle_model:      document.getElementById('b-model').value.trim(),
        tier:               (selectedPkg || '').toLowerCase(),
        frequency:          parseInt(selectedFreq) || 0,
        addons,
        preferred_date:     document.getElementById('b-date').value,
        marketing_consent:  document.getElementById('b-marketing')?.checked || false,
      };
      try {
        await fetch('/api/bookings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (_) { /* offline fallback â€” still show confirmation */ }
      nextStep(5);
    }

    function resetBooking() {
      document.querySelectorAll('.form-step').forEach(s => s.classList.remove('active'));
      document.getElementById('step-1').classList.add('active');
      currentStep = 1;
      updateStepIndicator(1);
      document.querySelectorAll('.form-option').forEach(o => { o.classList.remove('selected'); o.querySelector('input').checked = false; });
      document.querySelectorAll('.addon-option').forEach(o => { o.classList.remove('selected'); o.querySelector('input').checked = false; });
      ['b-name','b-phone','b-email','b-make','b-model','b-date'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      const mkt = document.getElementById('b-marketing'); if (mkt) mkt.checked = false;
    }

    /* â”€â”€ Option selectors â”€â”€ */
    function wirePkgOptions() {
      document.querySelectorAll('#pkg-options .form-option').forEach(opt => {
        opt.addEventListener('click', () => {
          document.querySelectorAll('#pkg-options .form-option').forEach(o => o.classList.remove('selected'));
          opt.classList.add('selected');
          selectedPkg = opt.dataset.value;
        });
      });
    }
    document.querySelectorAll('#freq-options .form-option').forEach(opt => {
      opt.addEventListener('click', () => {
        document.querySelectorAll('#freq-options .form-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        selectedFreq = opt.dataset.value;
      });
    });
    function wireAddonOptions() {
      document.querySelectorAll('.addon-option').forEach(opt => {
        const input = opt.querySelector('input');
        if (input) input.addEventListener('change', () => { opt.classList.toggle('selected', input.checked); });
      });
    }
    wireAddonOptions();

    /* â”€â”€ Lightbox â”€â”€ */
    const lightbox = document.getElementById('lightbox');
    const lightboxImg = document.getElementById('lightbox-img');
    const lightboxCaption = document.getElementById('lightbox-caption');
    let lightboxItems = [];
    let lightboxIndex = 0;

    function openLightbox(src, items, idx, caption) {
      lightboxImg.src = src;
      lightboxItems = items || [{ url: src, caption: '' }];
      lightboxIndex = idx !== undefined ? idx : 0;
      lightbox.classList.add('open');
      document.body.style.overflow = 'hidden';
      const prevBtn = document.getElementById('lightbox-prev');
      const nextBtn = document.getElementById('lightbox-next');
      if (lightboxItems.length <= 1) {
        prevBtn.style.display = 'none';
        nextBtn.style.display = 'none';
      } else {
        prevBtn.style.display = 'flex';
        nextBtn.style.display = 'flex';
      }
      if (caption) {
        lightboxCaption.textContent = caption;
        lightboxCaption.style.display = 'block';
      } else {
        lightboxCaption.style.display = 'none';
      }
    }

    function lightboxNav(dir) {
      lightboxIndex = (lightboxIndex + dir + lightboxItems.length) % lightboxItems.length;
      const item = lightboxItems[lightboxIndex];
      lightboxImg.src = item.url;
      if (item.caption) {
        lightboxCaption.textContent = item.caption;
        lightboxCaption.style.display = 'block';
      } else {
        lightboxCaption.style.display = 'none';
      }
    }

    function closeLightbox() {
      lightbox.classList.remove('open');
      document.body.style.overflow = '';
    }
    document.addEventListener('keydown', e => {
      if (!lightbox.classList.contains('open')) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft')  lightboxNav(-1);
      if (e.key === 'ArrowRight') lightboxNav(1);
    });

    /* â”€â”€ Contact form â”€â”€ */
    async function handleContact(e) {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Sendingâ€¦';
      const body = {
        name:    document.getElementById('c-name').value.trim(),
        email:   document.getElementById('c-email').value.trim(),
        phone:   document.getElementById('c-phone').value.trim(),
        message: document.getElementById('c-msg').value.trim(),
      };
      try {
        await fetch('/api/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (_) { /* offline fallback */ }
      btn.textContent = 'Message Sent âœ“';
      setTimeout(() => {
        btn.textContent = 'Send Message';
        btn.disabled = false;
        e.target.reset();
      }, 3000);
    }

    /* â”€â”€ Dynamic data from API â”€â”€ */
    async function initDynamic() {
      try {
        // Load settings (social links + contact info + hero)
        const s = await fetch('/api/settings').then(r => r.json());
        // Social links â€” nav + footer
        document.querySelectorAll('[data-social="instagram"]').forEach(a => { if (s.instagram_url && s.instagram_url !== '#') a.href = s.instagram_url; });
        document.querySelectorAll('[data-social="facebook"]').forEach(a =>  { if (s.facebook_url  && s.facebook_url  !== '#') a.href = s.facebook_url; });
        document.querySelectorAll('[data-social="tiktok"]').forEach(a =>    { if (s.tiktok_url    && s.tiktok_url    !== '#') a.href = s.tiktok_url; });
        document.querySelectorAll('[data-social="twitter"]').forEach(a =>   { if (s.twitter_url   && s.twitter_url   !== '#') a.href = s.twitter_url; });
        // Contact info
        if (s.phone)   document.querySelectorAll('[data-contact="phone"]').forEach(el => el.textContent = s.phone);
        if (s.email)   document.querySelectorAll('[data-contact="email"]').forEach(el => { el.textContent = s.email; if (el.tagName === 'A') el.href = 'mailto:' + s.email; });
        if (s.address) document.querySelectorAll('[data-contact="address"]').forEach(el => el.textContent = s.address);
        // Hero content
        const tagEl      = document.querySelector('[data-hero="tag"]');
        const headlineEl = document.querySelector('[data-hero="headline"]');
        const subEl      = document.querySelector('[data-hero="sub"]');
        const cta1El     = document.querySelector('[data-hero="cta1"]');
        const cta2El     = document.querySelector('[data-hero="cta2"]');
        const heroBgEl   = document.getElementById('hero-bg');
        if (tagEl      && s.hero_tag)       tagEl.textContent   = s.hero_tag;
        if (headlineEl && s.hero_headline)  headlineEl.innerHTML = s.hero_headline;
        if (subEl      && s.hero_sub)       subEl.textContent   = s.hero_sub;
        if (cta1El) { if (s.hero_cta1_text) cta1El.textContent = s.hero_cta1_text; if (s.hero_cta1_link) cta1El.href = s.hero_cta1_link; }
        if (cta2El) { if (s.hero_cta2_text) cta2El.textContent = s.hero_cta2_text; if (s.hero_cta2_link) cta2El.href = s.hero_cta2_link; }
        if (heroBgEl && s.hero_bg_url) {
          heroBgEl.style.background = `radial-gradient(ellipse 80% 60% at 60% 55%, rgba(26,111,255,.12) 0%, transparent 65%), radial-gradient(ellipse 50% 40% at 20% 80%, rgba(26,111,255,.06) 0%, transparent 60%), linear-gradient(180deg, rgba(13,13,13,0) 0%, rgba(13,13,13,.7) 70%, #0D0D0D 100%), url("${s.hero_bg_url}") center/cover no-repeat`;
        }
        // Hero colors
        const tagColor      = s.hero_tag_color      || '#1A6FFF';
        const headlineColor = s.hero_headline_color || '#F5F5F5';
        const accentColor   = s.hero_accent_color   || '#6B6B6B';
        const subColor      = s.hero_sub_color      || '#C4C4C4';
        if (tagEl)      { tagEl.style.color = tagColor; tagEl.style.borderColor = tagColor + '4D'; }
        if (headlineEl) headlineEl.style.color = headlineColor;
        if (subEl)      subEl.style.color = subColor;
        // Inject styles for pseudo-elements and em stroke
        const dynStyle = document.getElementById('hero-dynamic-style') || document.createElement('style');
        dynStyle.id = 'hero-dynamic-style';
        dynStyle.textContent = `.hero-tag::before{background:${tagColor}!important;box-shadow:0 0 8px ${tagColor}!important}.hero-headline em{-webkit-text-stroke-color:${accentColor}!important}`;
        if (!dynStyle.parentNode) document.head.appendChild(dynStyle);

        // â”€â”€ Global typography & brand â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        function loadGoogleFont(name) {
          if (!name || name === 'Bebas Neue' || name === 'DM Sans') return;
          if (document.querySelector(`link[data-font="${name}"]`)) return;
          const lk = document.createElement('link');
          lk.rel = 'stylesheet'; lk.dataset.font = name;
          lk.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g,'+')}:wght@300;400;500;600;700&display=swap`;
          document.head.appendChild(lk);
        }
        const root = document.documentElement;
        if (s.global_brand_color) {
          root.style.setProperty('--blue', s.global_brand_color);
          root.style.setProperty('--blue-dim', s.global_brand_color);
        }
        if (s.global_body_color)   root.style.setProperty('--white', s.global_body_color);
        if (s.global_body_size)    document.body.style.fontSize = s.global_body_size + 'px';
        if (s.global_body_line_height) document.body.style.lineHeight = s.global_body_line_height;
        if (s.global_btn_radius)   root.style.setProperty('--radius-sm', s.global_btn_radius + 'px');
        if (s.global_heading_font && s.global_heading_font !== 'Bebas Neue') {
          loadGoogleFont(s.global_heading_font);
          root.style.setProperty('--font-display', `'${s.global_heading_font}', sans-serif`);
        }
        if (s.global_body_font && s.global_body_font !== 'DM Sans') {
          loadGoogleFont(s.global_body_font);
          root.style.setProperty('--font-body', `'${s.global_body_font}', sans-serif`);
        }
        if (s.global_heading_color || s.global_heading_letter_spacing) {
          let hStyle = document.getElementById('global-heading-style') || document.createElement('style');
          hStyle.id = 'global-heading-style';
          let hCss = '';
          if (s.global_heading_color) hCss += `.section-label,.hero-headline,.tier-name,.form-step-title,.confirm-title{color:${s.global_heading_color}!important}`;
          if (s.global_heading_letter_spacing) hCss += `.section-label,.hero-headline,.tier-name{letter-spacing:${s.global_heading_letter_spacing}em!important}`;
          hStyle.textContent = hCss;
          if (!hStyle.parentNode) document.head.appendChild(hStyle);
        }

        // â”€â”€ Section show / hide â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (s.nav_show === '0')      document.getElementById('navbar').style.display = 'none';
        if (s.hero_show === '0')     document.getElementById('hero').style.display = 'none';
        if (s.stats_show === '0')    document.getElementById('stats').style.display = 'none';
        if (s.packages_show === '0') document.getElementById('packages').style.display = 'none';
        if (s.booking_show === '0')  document.getElementById('booking').style.display = 'none';
        if (s.gallery_show === '0')  document.getElementById('gallery').style.display = 'none';
        if (s.contact_show === '0')  document.getElementById('contact').style.display = 'none';
        if (s.footer_show === '0') { const fe = document.getElementById('footer-el'); if (fe) fe.style.display = 'none'; }

        // â”€â”€ Hero extra â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (s.hero_padding_top) { const h = document.getElementById('hero'); if (h) h.style.paddingTop = s.hero_padding_top + 'px'; }
        if (s.nav_bg_color) {
          let ns = document.getElementById('nav-dynamic-style') || document.createElement('style');
          ns.id = 'nav-dynamic-style';
          ns.textContent = `#navbar.scrolled{background:${s.nav_bg_color}!important}`;
          if (!ns.parentNode) document.head.appendChild(ns);
        }
        // â”€â”€ Navbar CTA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const ctaBtn = document.getElementById('nav-cta-btn');
        if (ctaBtn) {
          if (s.nav_cta_text) ctaBtn.textContent = s.nav_cta_text;
          if (s.nav_cta_link) ctaBtn.href = s.nav_cta_link;
        }

        // â”€â”€ Stats â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (s.stat1_num)   { const e = document.getElementById('stat-num-1');   if (e) e.textContent = s.stat1_num; }
        if (s.stat1_label) { const e = document.getElementById('stat-label-1'); if (e) e.textContent = s.stat1_label; }
        if (s.stat2_num)   { const e = document.getElementById('stat-num-2');   if (e) e.textContent = s.stat2_num; }
        if (s.stat2_label) { const e = document.getElementById('stat-label-2'); if (e) e.textContent = s.stat2_label; }
        if (s.stat3_num)   { const e = document.getElementById('stat-num-3');   if (e) e.textContent = s.stat3_num; }
        if (s.stat3_label) { const e = document.getElementById('stat-label-3'); if (e) e.textContent = s.stat3_label; }
        if (s.stat4_num)   { const e = document.getElementById('stat-num-4');   if (e) e.textContent = s.stat4_num; }
        if (s.stat4_label) { const e = document.getElementById('stat-label-4'); if (e) e.textContent = s.stat4_label; }
        const statsEl = document.getElementById('stats');
        if (statsEl) {
          if (s.stats_padding_top)    statsEl.style.paddingTop    = s.stats_padding_top + 'px';
          if (s.stats_padding_bottom) statsEl.style.paddingBottom = s.stats_padding_bottom + 'px';
          if (s.stats_bg_color)       statsEl.style.background    = s.stats_bg_color;
        }
        if (s.stats_num_color)   document.querySelectorAll('.stat-num').forEach(e => e.style.color = s.stats_num_color);
        if (s.stats_label_color) document.querySelectorAll('.stat-label').forEach(e => e.style.color = s.stats_label_color);

        // â”€â”€ Packages section header â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const pkgSec = document.getElementById('packages');
        if (pkgSec) {
          if (s.packages_title) { const e = document.getElementById('packages-title-el'); if (e) e.textContent = s.packages_title; }
          if (s.packages_sub)   { const e = document.getElementById('packages-sub-el');   if (e) e.textContent = s.packages_sub; }
          if (s.packages_title_color) { const e = document.getElementById('packages-title-el'); if (e) e.style.color = s.packages_title_color; }
          if (s.packages_padding_top)    pkgSec.style.paddingTop    = s.packages_padding_top + 'px';
          if (s.packages_padding_bottom) pkgSec.style.paddingBottom = s.packages_padding_bottom + 'px';
          if (s.packages_bg_color)       pkgSec.style.background    = s.packages_bg_color;
        }
        // â”€â”€ Booking section â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const bookSec = document.getElementById('booking');
        if (bookSec) {
          if (s.booking_title) { const e = document.getElementById('booking-title-el'); if (e) e.textContent = s.booking_title; }
          if (s.booking_sub)   { const e = document.getElementById('booking-sub-el');   if (e) e.textContent = s.booking_sub; }
          if (s.booking_title_color) { const e = document.getElementById('booking-title-el'); if (e) e.style.color = s.booking_title_color; }
          if (s.booking_padding_top)    bookSec.style.paddingTop    = s.booking_padding_top + 'px';
          if (s.booking_padding_bottom) bookSec.style.paddingBottom = s.booking_padding_bottom + 'px';
          if (s.booking_bg_color)       bookSec.style.background    = s.booking_bg_color;
        }

        // â”€â”€ Gallery section â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const gallSec = document.getElementById('gallery');
        if (gallSec) {
          if (s.gallery_title) { const e = document.getElementById('gallery-title-el'); if (e) e.textContent = s.gallery_title; }
          if (s.gallery_sub)   { const e = document.getElementById('gallery-sub-el');   if (e) e.textContent = s.gallery_sub; }
          if (s.gallery_title_color) { const e = document.getElementById('gallery-title-el'); if (e) e.style.color = s.gallery_title_color; }
          if (s.gallery_padding_top)    gallSec.style.paddingTop    = s.gallery_padding_top + 'px';
          if (s.gallery_padding_bottom) gallSec.style.paddingBottom = s.gallery_padding_bottom + 'px';
          if (s.gallery_bg_color)       gallSec.style.background    = s.gallery_bg_color;
        }

        // â”€â”€ Contact section â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const contSec = document.getElementById('contact');
        if (contSec) {
          if (s.contact_title) { const e = document.getElementById('contact-title-el'); if (e) e.textContent = s.contact_title; }
          if (s.contact_sub)   { const e = document.getElementById('contact-sub-el');   if (e) e.textContent = s.contact_sub; }
          if (s.contact_title_color) { const e = document.getElementById('contact-title-el'); if (e) e.style.color = s.contact_title_color; }
          if (s.contact_padding_top)    contSec.style.paddingTop    = s.contact_padding_top + 'px';
          if (s.contact_padding_bottom) contSec.style.paddingBottom = s.contact_padding_bottom + 'px';
          if (s.contact_bg_color)       contSec.style.background    = s.contact_bg_color;
        }

        // â”€â”€ Footer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const footerDom = document.getElementById('footer-el');
        if (footerDom) {
          if (s.footer_tagline)   { const e = document.getElementById('footer-tagline-el'); if (e) e.textContent = s.footer_tagline; }
          if (s.footer_copyright) { const e = document.getElementById('footer-copy-el');    if (e) e.textContent = s.footer_copyright; }
          if (s.footer_bg_color)  footerDom.style.background = s.footer_bg_color;
        }

        // Load packages (name, price, about)
        const pkgs = await fetch('/api/packages').then(r => r.json());
        const pkgGrid  = document.getElementById('packages-grid');
        const pkgEmpty = document.getElementById('packages-empty');
        if (pkgGrid) {
          if (pkgs.length) {
            pkgEmpty.style.display = 'none';
            pkgGrid.innerHTML = pkgs.map(p => `
              <div class="sub-card fade-in">
                <div class="sub-card-name">${escHtml(p.name)}</div>
                <div class="sub-card-price">
                  <span class="currency">&pound;</span>
                  <span class="amount">${parseInt(p.price) || 0}</span>
                </div>
                ${p.about ? `<p class="sub-card-desc" style="white-space:pre-line">${escHtml(p.about)}</p>` : ''}
                <button class="sub-cta-btn pkg-book-btn" data-pkg-name="${escHtml(p.name)}" style="margin-top:auto">Book This Package</button>
              </div>`).join('');
            document.querySelectorAll('.pkg-book-btn').forEach(btn => {
              btn.addEventListener('click', () => prefillBooking(btn.dataset.pkgName));
            });
            observeFadeIns();
          } else {
            pkgGrid.innerHTML = '';
            if (pkgEmpty) pkgEmpty.style.display = '';
          }
        }
        // Populate booking form's package step from the same list
        const pkgOptionsEl = document.getElementById('pkg-options');
        if (pkgOptionsEl) {
          pkgOptionsEl.innerHTML = pkgs.map(p => `
            <label class="form-option" data-value="${escHtml(p.name)}">
              <input type="radio" name="package" value="${escHtml(p.name)}" />
              <div class="form-option-dot"></div>
              <div class="form-option-label">${escHtml(p.name.toUpperCase())}</div>
              <div class="form-option-sub">&pound;${parseInt(p.price) || 0}</div>
            </label>`).join('');
          wirePkgOptions();
        }

        // Load add-ons (booking form step 3)
        const addons = await fetch('/api/addons').then(r => r.json());
        const addonOptionsEl = document.getElementById('addon-options');
        if (addonOptionsEl) {
          addonOptionsEl.innerHTML = addons.map(a => `
            <label class="addon-option" data-value="${escHtml(a.name)}">
              <input type="checkbox" name="addons" value="${escHtml(a.name)}" />
              <div class="addon-check"></div>
              <div>
                <div class="addon-name">${escHtml(a.name)}</div>
                <div class="addon-price">+&pound;${parseInt(a.price) || 0}/session</div>
              </div>
            </label>`).join('');
          wireAddonOptions();
        }

        // Load media (gallery photos)
        const media = await fetch('/api/media').then(r => r.json());
        const photos = media.filter(m => m.type === 'photo');
        const videos = media.filter(m => m.type === 'video');
        if (photos.length) {
          const grid = document.querySelector('.gallery-grid');
          if (grid) {
            const lbItems = photos.map(m => ({ url: m.url, caption: m.caption || m.label || '' }));
            grid.innerHTML = photos.map((m, i) => `
              <div class="gallery-item" onclick="openLightbox('${m.url}', lbGalleryItems, ${i}, '${(m.caption||m.label||'').replace(/'/g,"\\'")}')">
                <img src="${m.url}" alt="${m.alt_text || m.label || 'Gallery'}" loading="lazy" />
                <div class="gallery-overlay"><div class="gallery-overlay-text">${m.label || 'Click to enlarge'}</div></div>
              </div>`).join('');
            window.lbGalleryItems = lbItems;
          }
        }
        if (videos.length) {
          const testGrid = document.querySelector('.testimonials-grid');
          if (testGrid) {
            testGrid.innerHTML = videos.map(m => `
              <div class="testimonial-card">
                <div class="testimonial-thumb">
                  <img src="${m.url.startsWith('/uploads') ? m.url : 'https://placehold.co/480x270/0D0D0D/C4C4C4?text=Video'}" alt="${m.label || 'Testimonial'}" loading="lazy" />
                  <div class="play-btn"><div class="play-btn-circle"><svg width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg></div></div>
                </div>
                <div class="testimonial-info">
                  <div class="testimonial-name">${m.label || ''}</div>
                  <div class="testimonial-vehicle">${m.vehicle || ''}</div>
                </div>
              </div>`).join('');
          }
        }
      } catch (_) { /* API unavailable â€” static content remains */ }

      // â”€â”€ Subscription packages â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      try {
        const subPkgs = await fetch('/api/sub-packages').then(r => r.json());
        const grid = document.getElementById('subs-grid');
        if (grid && subPkgs.length) {
          grid.innerHTML = subPkgs.map(pkg => {
            const pence = pkg.price_pence || 0;
            const pounds = Math.floor(pence / 100);
            const pFeat = (pkg.features || []).map(f => `
              <li>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                ${f}
              </li>`).join('');
            return `
              <div class="sub-card fade-in ${pkg.popular ? 'popular' : ''}">
                ${pkg.popular ? '<div class="sub-popular-badge">Most Popular</div>' : ''}
                <div class="sub-card-name">${pkg.name}</div>
                <div class="sub-card-desc">${pkg.description || ''}</div>
                <div class="sub-card-price">
                  <span class="currency">&pound;</span>
                  <span class="amount">${pounds}</span>
                  <span class="period">/ mo</span>
                </div>
                <ul class="sub-card-features">${pFeat}</ul>
                <button class="sub-cta-btn ${pkg.popular ? 'popular-btn' : ''}" onclick="openCheckout(${pkg.id}, '${pkg.name}', ${pence})">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                  Subscribe Now
                </button>
              </div>`;
          }).join('');
          observeFadeIns();
        }
      } catch (_) {}

      // â”€â”€ Handle subscribe success redirect â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (window.location.pathname === '/subscribe/success') {
        setTimeout(() => {
          document.getElementById('subscriptions')?.scrollIntoView({ behavior: 'smooth' });
          showCheckoutSuccess();
        }, 400);
      }
    }
    initDynamic();

    /* â”€â”€ Hero Slideshow â”€â”€ */
    (async function initSlideshow() {
      try {
        const [slides, settings] = await Promise.all([
          fetch('/api/slides').then(r => r.json()),
          fetch('/api/settings').then(r => r.json()),
        ]);
        if (!slides.length || settings.slideshow_enabled === '0') return;

        const container   = document.getElementById('hero-slideshow');
        const staticBg    = document.getElementById('hero-bg');
        const staticCont  = document.getElementById('hero-static-content');
        const dotsEl      = document.getElementById('slide-dots');
        const arrowsEl    = document.getElementById('slide-arrows');
        const transition  = settings.slideshow_transition || 'fade';
        const interval    = Math.max(2, parseInt(settings.slideshow_interval) || 5) * 1000;
        const autoplay    = settings.slideshow_autoplay !== '0';
        const showDots    = settings.slideshow_dots !== '0';
        const showArrows  = settings.slideshow_arrows !== '0';
        const isMobile    = window.matchMedia('(max-width:767px)').matches;

        // Hide static fallback, show slideshow
        staticBg.style.display   = 'none';
        staticCont.style.display = 'none';
        container.style.display  = 'block';

        // Build slide elements
        const brandColor = getComputedStyle(document.documentElement).getPropertyValue('--blue').trim() || '#1A6FFF';
        slides.forEach((s, i) => {
          const slide = document.createElement('div');
          slide.className = 'hero-slide' + (i === 0 ? ' active' : '');
          slide.dataset.index = i;

          // Background: prefer video on desktop, image on mobile
          const hasVideo = s.video_url && !isMobile;
          if (hasVideo) {
            slide.innerHTML = `
              <video class="slide-video" autoplay muted loop playsinline poster="${s.image_url || ''}">
                <source src="${s.video_url}" />
              </video>`;
          } else if (s.image_url) {
            const bg = document.createElement('div');
            bg.className = 'slide-bg-img';
            bg.style.backgroundImage = `url('${s.image_url}')`;
            slide.appendChild(bg);
          }

          // Overlay
          const overlay = document.createElement('div');
          overlay.className = 'slide-overlay';
          overlay.style.background = hexToRgba(s.overlay_color || '#000', s.overlay_opacity ?? 0.5);
          slide.appendChild(overlay);

          // Content
          const contentDiv = document.createElement('div');
          contentDiv.className = 'container';
          contentDiv.innerHTML = `<div class="slide-content">
            ${s.headline ? `<h1 class="hero-headline">${s.headline}</h1>` : ''}
            ${s.sub      ? `<p class="hero-sub">${s.sub}</p>` : ''}
            <div class="hero-ctas">
              ${s.cta1_text ? `<a href="${s.cta1_link||'#'}" class="btn btn-primary">${s.cta1_text}</a>` : ''}
              ${s.cta2_text ? `<a href="${s.cta2_link||'#'}" class="btn btn-outline">${s.cta2_text}</a>` : ''}
            </div>
          </div>`;
          slide.appendChild(contentDiv);
          container.appendChild(slide);
        });

        // Dots
        if (showDots && slides.length > 1) {
          dotsEl.style.display = 'flex';
          slides.forEach((_, i) => {
            const d = document.createElement('button');
            d.className = 'slide-dot' + (i === 0 ? ' active' : '');
            d.setAttribute('aria-label', `Go to slide ${i + 1}`);
            d.onclick = () => goTo(i);
            dotsEl.appendChild(d);
          });
        }

        // Arrows
        if (showArrows && slides.length > 1) arrowsEl.style.display = 'flex';
        document.getElementById('slide-prev').onclick = () => goTo(current - 1);
        document.getElementById('slide-next').onclick = () => goTo(current + 1);

        let current = 0;
        let timer = null;

        function goTo(idx) {
          const all    = container.querySelectorAll('.hero-slide');
          const dots   = dotsEl.querySelectorAll('.slide-dot');
          const next   = (idx + slides.length) % slides.length;
          all[current].classList.remove('active');
          all[next].classList.add('active');
          if (dots.length) { dots[current].classList.remove('active'); dots[next].classList.add('active'); }
          current = next;
          if (autoplay) resetTimer();
        }

        function resetTimer() {
          clearInterval(timer);
          timer = setInterval(() => goTo(current + 1), interval);
        }

        if (autoplay && slides.length > 1) {
          resetTimer();
          // Pause on hover (desktop)
          container.addEventListener('mouseenter', () => clearInterval(timer));
          container.addEventListener('mouseleave', resetTimer);
        }

        // Touch/swipe support
        let touchX = 0;
        container.addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
        container.addEventListener('touchend', e => {
          const dx = e.changedTouches[0].clientX - touchX;
          if (Math.abs(dx) > 50) goTo(current + (dx < 0 ? 1 : -1));
        }, { passive: true });

      } catch (_) {}
    })();

    function hexToRgba(hex, alpha) {
      const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
      return `rgba(${r},${g},${b},${alpha})`;
    }

    /* â”€â”€ Subscription checkout â”€â”€ */
    let _checkoutPkg = null;

    function openCheckout(pkgId, pkgName, pricePence) {
      _checkoutPkg = { id: pkgId, name: pkgName, pricePence };
      const pounds = Math.floor(pricePence / 100);
      const pence  = pricePence % 100;
      const priceStr = `£${pounds}${pence ? '.' + String(pence).padStart(2,'0') : ''}`;
      document.getElementById('checkout-body').innerHTML = `
        <div class="checkout-pkg-badge">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          ${pkgName} Plan
        </div>
        <h3>Start Your Subscription</h3>
        <p class="sub">You'll be securely redirected to Stripe to complete your payment. Your card or bank details are never stored on our servers.</p>
        <div class="checkout-field">
          <label>Full Name</label>
          <input type="text" id="co-name" placeholder="Your full name" autocomplete="name" required />
        </div>
        <div class="checkout-field">
          <label>Email Address</label>
          <input type="email" id="co-email" placeholder="you@example.com" autocomplete="email" required />
        </div>
        <div class="checkout-price-row">
          <span class="checkout-price-label">Monthly total</span>
          <span class="checkout-price-val">${priceStr}<small style="font-size:.7em;color:var(--silver-lo)">/mo</small></span>
        </div>
        <label style="display:flex;align-items:flex-start;gap:10px;margin-bottom:18px;cursor:pointer">
          <input type="checkbox" id="co-marketing" style="margin-top:3px;width:auto;flex-shrink:0;accent-color:var(--blue)" />
          <span style="font-size:.78rem;color:var(--silver-lo);line-height:1.55">I would like to receive offers, news and updates by email. You can unsubscribe at any time.</span>
        </label>
        <p style="font-size:.7rem;color:var(--silver-lo);margin-bottom:16px">By proceeding you confirm you have read our <a href="/privacy-policy" style="color:var(--blue)" target="_blank">Privacy Policy</a> and <a href="/terms" style="color:var(--blue)" target="_blank">Terms &amp; Conditions</a>.</p>
        <button class="checkout-submit" id="checkout-submit-btn" onclick="submitCheckout()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
          Proceed to Payment
        </button>
        <div class="checkout-security-note">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
          Secured by Stripe Â· Cancel anytime
        </div>`;
      document.getElementById('checkout-modal-bg').classList.add('open');
      document.body.style.overflow = 'hidden';
    }

    function closeCheckout() {
      document.getElementById('checkout-modal-bg').classList.remove('open');
      document.body.style.overflow = '';
    }

    function showCheckoutSuccess() {
      document.getElementById('checkout-body').innerHTML = `
        <div class="checkout-success">
          <div class="checkout-success-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <div style="font-family:var(--font-display);font-size:2rem;letter-spacing:.06em;margin-bottom:12px">SUBSCRIBED!</div>
          <p style="color:var(--silver);font-size:.93rem;line-height:1.7">You're all set. A confirmation email is on its way. Your first detail will be arranged within 48 hours.</p>
          <br>
          <button class="btn btn-outline" onclick="closeCheckout()">Close</button>
        </div>`;
      document.getElementById('checkout-modal-bg').classList.add('open');
    }

    async function submitCheckout() {
      const name  = document.getElementById('co-name')?.value.trim();
      const email = document.getElementById('co-email')?.value.trim();
      if (!name || !email) { alert('Please fill in your name and email.'); return; }
      const btn = document.getElementById('checkout-submit-btn');
      btn.disabled = true;
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Redirectingâ€¦';
      try {
        const res  = await fetch('/api/subscribe/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ package_id: _checkoutPkg.id, customer_name: name, customer_email: email }),
        });
        const data = await res.json();
        if (data.url) {
          window.location.href = data.url;
        } else {
          document.getElementById('checkout-body').innerHTML += `<p style="color:#ef4444;font-size:.82rem;margin-top:12px">âš  ${data.error || 'Something went wrong. Please try again.'}</p>`;
          btn.disabled = false;
          btn.innerHTML = 'Proceed to Payment';
        }
      } catch (err) {
        btn.disabled = false;
        btn.innerHTML = 'Proceed to Payment';
      }
    }

    document.getElementById('checkout-modal-bg').addEventListener('click', function(e) {
      if (e.target === this) closeCheckout();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCheckout(); });

    /* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
       COOKIE CONSENT
    â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
    (function() {
      const COOKIE_NAME   = 'ctd_consent';
      const COOKIE_EXPIRY = 365; // days

      function getCookie(name) {
        const match = document.cookie.split('; ').find(r => r.startsWith(name + '='));
        return match ? decodeURIComponent(match.split('=')[1]) : null;
      }

      function setCookie(name, value, days) {
        const d = new Date();
        d.setDate(d.getDate() + days);
        document.cookie = `${name}=${encodeURIComponent(value)}; expires=${d.toUTCString()}; path=/; SameSite=Strict`;
      }

      function getConsent() {
        try { return JSON.parse(getCookie(COOKIE_NAME) || 'null'); } catch { return null; }
      }

      function saveConsent(prefs) {
        prefs.saved_at = new Date().toISOString();
        setCookie(COOKIE_NAME, JSON.stringify(prefs), COOKIE_EXPIRY);
        hideBanner();
        applyConsent(prefs);
        fetch('/api/consent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preferences: { functional: prefs.functional, analytics: prefs.analytics, marketing: prefs.marketing }, source: 'cookie_banner' }),
        }).catch(() => {});
      }

      function applyConsent(prefs) {
        /* Load analytics only if consented */
        if (prefs.analytics && !window.__ga_loaded) {
          window.__ga_loaded = true;
          /* Replace UA-XXXXXXXX with your real GA4 Measurement ID */
          const s = document.createElement('script');
          s.async = true;
          s.src = 'https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX';
          document.head.appendChild(s);
          window.dataLayer = window.dataLayer || [];
          window.gtag = function() { dataLayer.push(arguments); };
          gtag('js', new Date());
          gtag('config', 'G-XXXXXXXXXX', { anonymize_ip: true });
        }
      }

      function showBanner() {
        const b = document.getElementById('cookie-banner');
        setTimeout(() => b.classList.add('visible'), 600);
      }

      function hideBanner() {
        document.getElementById('cookie-banner').classList.remove('visible');
      }

      window.cookieAcceptAll = function() {
        saveConsent({ essential: true, functional: true, analytics: true, marketing: true });
      };

      window.cookieRejectAll = function() {
        saveConsent({ essential: true, functional: false, analytics: false, marketing: false });
      };

      window.openCookieSettings = function() {
        const prefs = getConsent();
        document.getElementById('ck-functional').checked = prefs ? prefs.functional : false;
        document.getElementById('ck-analytics').checked  = prefs ? prefs.analytics  : false;
        document.getElementById('ck-marketing').checked  = prefs ? prefs.marketing  : false;
        document.getElementById('cookie-modal-bg').classList.add('open');
      };

      window.closeCookieModal = function() {
        document.getElementById('cookie-modal-bg').classList.remove('open');
      };

      window.cookieSavePreferences = function() {
        saveConsent({
          essential:  true,
          functional: document.getElementById('ck-functional').checked,
          analytics:  document.getElementById('ck-analytics').checked,
          marketing:  document.getElementById('ck-marketing').checked,
        });
        closeCookieModal();
      };

      document.getElementById('cookie-modal-bg').addEventListener('click', function(e) {
        if (e.target === this) closeCookieModal();
      });

      /* On load: check if consent already given */
      const existing = getConsent();
      if (!existing) {
        showBanner();
      } else {
        /* Re-check every 12 months */
        const savedAt = existing.saved_at ? new Date(existing.saved_at) : null;
        const twelveMonthsAgo = new Date(); twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
        if (savedAt && savedAt < twelveMonthsAgo) {
          showBanner();
        } else {
          applyConsent(existing);
        }
      }
    })();
