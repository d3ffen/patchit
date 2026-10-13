/* PatchIt landing page — theme toggle, mobile nav, scroll spy, sticky CTA. */
(function () {
  'use strict';

  var root = document.documentElement;

  /* ---------------------------------------------------------------- *
   * Theme
   *
   * The app ships dark by default, so the page does too. A stored choice
   * wins; otherwise we stay on the M3 baseline dark palette.
   * ---------------------------------------------------------------- */
  var THEME_KEY = 'patchit-theme';
  var THEME_COLORS = { dark: '#141218', light: '#fef7ff' };

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);

    var meta = document.getElementById('theme-color');
    if (meta) meta.setAttribute('content', THEME_COLORS[theme] || THEME_COLORS.dark);

    var sun = document.querySelector('.theme-icon-dark');
    var moon = document.querySelector('.theme-icon-light');
    if (sun) sun.hidden = theme !== 'dark';
    if (moon) moon.hidden = theme !== 'light';
  }

  var stored = null;
  try {
    stored = window.localStorage.getItem(THEME_KEY);
  } catch (error) {
    /* Private mode or storage disabled — fall back to the default. */
  }
  applyTheme(stored === 'light' ? 'light' : 'dark');

  var themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try {
        window.localStorage.setItem(THEME_KEY, next);
      } catch (error) {
        /* Not fatal: the choice just will not persist. */
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * Mobile navigation + scrim + body scroll lock
   * ---------------------------------------------------------------- */
  var nav = document.getElementById('nav');
  var navToggle = document.getElementById('nav-toggle');
  var scrim = document.getElementById('nav-scrim');

  function setNav(open) {
    if (!nav || !navToggle) return;
    nav.classList.toggle('is-open', open);
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    document.body.classList.toggle('nav-open', open);

    var openIcon = navToggle.querySelector('.nav-icon-open');
    var closeIcon = navToggle.querySelector('.nav-icon-close');
    if (openIcon) openIcon.hidden = open;
    if (closeIcon) closeIcon.hidden = !open;

    if (scrim) {
      scrim.hidden = !open;
      if (open) {
        /* Let the element paint before fading the scrim in. */
        window.requestAnimationFrame(function () {
          scrim.classList.add('is-open');
        });
      } else {
        scrim.classList.remove('is-open');
      }
    }
  }

  if (nav && navToggle) {
    navToggle.addEventListener('click', function () {
      setNav(!nav.classList.contains('is-open'));
    });

    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) setNav(false);
    });

    if (scrim) {
      scrim.addEventListener('click', function () {
        setNav(false);
      });
    }

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') setNav(false);
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 760) setNav(false);
    });
  }

  /* ---------------------------------------------------------------- *
   * Scroll spy — highlight the section currently crossing mid-viewport
   * ---------------------------------------------------------------- */
  var navLinks = {};
  if (nav) {
    Array.prototype.forEach.call(nav.querySelectorAll('a[href^="#"]'), function (link) {
      navLinks[link.getAttribute('href').slice(1)] = link;
    });
  }

  function setActive(id) {
    Object.keys(navLinks).forEach(function (key) {
      navLinks[key].classList.toggle('is-active', key === id);
    });
  }

  if ('IntersectionObserver' in window && Object.keys(navLinks).length) {
    var spy = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) setActive(entry.target.id);
        });
      },
      { rootMargin: '-45% 0px -50% 0px', threshold: 0 },
    );

    Object.keys(navLinks).forEach(function (id) {
      var section = document.getElementById(id);
      if (section) spy.observe(section);
    });
  }

  /* ---------------------------------------------------------------- *
   * Sticky mobile download bar
   *
   * Appears once the hero is scrolled past, and steps aside for the big
   * CTA band near the footer so the two never compete.
   * ---------------------------------------------------------------- */
  var bar = document.getElementById('mobile-cta');
  var hero = document.querySelector('.hero');
  var finalCta = document.querySelector('.cta');
  var footer = document.querySelector('.site-footer');

  if (bar && 'IntersectionObserver' in window) {
    var pastHero = false;
    var ctaInView = false;
    var footerInView = false;

    var updateBar = function () {
      bar.classList.toggle('is-visible', pastHero && !ctaInView && !footerInView);
    };

    var watch = function (el, threshold, onChange) {
      if (!el) return;
      new IntersectionObserver(function (entries) {
        onChange(entries[0].isIntersecting);
        updateBar();
      }, { threshold: threshold }).observe(el);
    };

    watch(hero, 0, function (v) {
      pastHero = !v;
    });
    watch(finalCta, 0.15, function (v) {
      ctaInView = v;
    });
    watch(footer, 0.1, function (v) {
      footerInView = v;
    });
  }

  /* ---------------------------------------------------------------- *
   * Reveal on scroll
   * ---------------------------------------------------------------- */
  var reveals = document.querySelectorAll('.reveal');
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!reduced && 'IntersectionObserver' in window) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    reveals.forEach(function (el) {
      observer.observe(el);
    });
  } else {
    reveals.forEach(function (el) {
      el.classList.add('is-visible');
    });
  }

  /* ---------------------------------------------------------------- *
   * Footer year
   * ---------------------------------------------------------------- */
  var year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
})();
