/**
 * Animations & Smooth Scrolling Controller
 * ---------------------------------------
 * Integrates:
 * 1. Lenis (smooth desktop scrolling)
 * 2. GSAP + ScrollTrigger (scroll-triggered reveals for cards, headers, tables)
 * 3. Motion One for Vanilla JS via ESM (micro-interactions, modals, button hovers)
 *
 * Designed to be hardware-accelerated (transform/opacity only) and non-intrusive
 * so attendance scanning and form submissions are never blocked.
 */

let motionLib = null;
let lenisInstance = null;
let scrollTriggersInitialized = false;

/**
 * Lazy-loads Motion One ESM safely with graceful fallback if offline/blocked.
 */
async function loadMotion() {
  if (motionLib) return motionLib;
  try {
    motionLib = await import("https://cdn.jsdelivr.net/npm/motion@10.17.0/+esm");
    return motionLib;
  } catch (err) {
    console.warn("[Animations] Motion One CDN unavailable, falling back to CSS transitions.", err);
    return null;
  }
}

/**
 * Initializes Lenis smooth scrolling on desktop viewports and links it to GSAP ScrollTrigger.
 * @param {object} options
 * @param {HTMLElement|Window} [options.wrapper] - Optional scroll wrapper element
 */
export function initSmoothScroll(options = {}) {
  if (typeof window === "undefined") return null;

  // Respect user's reduced-motion preference
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReducedMotion) return null;

  const LenisClass = window.Lenis;
  if (!LenisClass) return null;

  if (lenisInstance) {
    lenisInstance.destroy();
    lenisInstance = null;
  }

  const lenisOptions = {
    duration: 1.05,
    easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
    smoothWheel: true,
    touchMultiplier: 1.5
  };

  if (options.wrapper) {
    lenisOptions.wrapper = options.wrapper;
    lenisOptions.content = options.content || options.wrapper.firstElementChild;
  }

  lenisInstance = new LenisClass(lenisOptions);

  const gsap = window.gsap;
  const ScrollTrigger = window.ScrollTrigger;

  if (gsap && ScrollTrigger) {
    gsap.registerPlugin(ScrollTrigger);
    lenisInstance.on("scroll", ScrollTrigger.update);

    gsap.ticker.add((time) => {
      if (lenisInstance) {
        lenisInstance.raf(time * 1000);
      }
    });
    gsap.ticker.lagSmoothing(0);
  } else {
    function raf(time) {
      if (lenisInstance) {
        lenisInstance.raf(time);
        requestAnimationFrame(raf);
      }
    }
    requestAnimationFrame(raf);
  }

  return lenisInstance;
}

/**
 * Scrolls smoothly to top or target selector via Lenis if active.
 * @param {number|string|HTMLElement} target
 */
export function smoothScrollTo(target = 0) {
  if (lenisInstance) {
    lenisInstance.scrollTo(target, { immediate: false });
  } else if (typeof target === "number") {
    window.scrollTo({ top: target, behavior: "smooth" });
  }
}

/**
 * Registers GSAP ScrollTrigger reveals for `.gsap-reveal` elements inside a root container.
 * @param {HTMLElement|Document} root
 */
export function initScrollReveals(root = document) {
  const gsap = window.gsap;
  const ScrollTrigger = window.ScrollTrigger;
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const targets = Array.from(root.querySelectorAll(".gsap-reveal"));
  if (!targets.length) return;

  if (!gsap || !ScrollTrigger || prefersReducedMotion) {
    targets.forEach((el) => {
      el.style.opacity = "1";
      el.style.transform = "none";
    });
    return;
  }

  gsap.registerPlugin(ScrollTrigger);

  // Clean up old triggers on re-render of dynamic views
  if (scrollTriggersInitialized) {
    ScrollTrigger.refresh();
  }
  scrollTriggersInitialized = true;

  targets.forEach((el, index) => {
    if (el.dataset.gsapBound === "1") return;
    el.dataset.gsapBound = "1";

    const delay = Math.min((index % 5) * 0.045, 0.2);

    gsap.fromTo(
      el,
      { opacity: 0, y: 18 },
      {
        opacity: 1,
        y: 0,
        duration: 0.45,
        delay,
        ease: "power2.out",
        clearProps: "transform",
        scrollTrigger: {
          trigger: el,
          start: "top 92%",
          once: true
        }
      }
    );
  });
}

/**
 * Animates a group of elements with Motion One entrance transition.
 * @param {string|NodeList|HTMLElement[]} selectorOrElements
 * @param {object} [opts]
 */
export async function animateEntrance(selectorOrElements, opts = {}) {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const elements =
    typeof selectorOrElements === "string"
      ? Array.from(document.querySelectorAll(selectorOrElements))
      : Array.from(selectorOrElements || []);

  if (!elements.length || prefersReducedMotion) return;

  const motion = await loadMotion();
  if (!motion || !motion.animate) return;

  const staggerFn = motion.stagger || ((step) => (i) => i * step);

  motion.animate(
    elements,
    {
      opacity: [0, 1],
      transform: ["translateY(12px) scale(0.99)", "translateY(0px) scale(1)"]
    },
    {
      duration: opts.duration ?? 0.35,
      delay: elements.length > 1 ? staggerFn(opts.staggerDelay ?? 0.05) : 0,
      easing: [0.22, 1, 0.36, 1]
    }
  );
}

/**
 * Animates modal open popup using Motion One.
 * @param {HTMLElement} modalPanel
 */
export async function animateModalOpen(modalPanel) {
  if (!modalPanel) return;
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReducedMotion) return;

  const motion = await loadMotion();
  if (!motion || !motion.animate) return;

  motion.animate(
    modalPanel,
    {
      opacity: [0, 1],
      transform: ["translateY(14px) scale(0.96)", "translateY(0px) scale(1)"]
    },
    {
      duration: 0.26,
      easing: [0.16, 1, 0.3, 1]
    }
  );
}

/**
 * Animates modal close using Motion One and invokes callback on finish.
 * @param {HTMLElement} modalPanel
 * @returns {Promise<void>}
 */
export async function animateModalClose(modalPanel) {
  if (!modalPanel) return;
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReducedMotion) return;

  const motion = await loadMotion();
  if (!motion || !motion.animate) return;

  const controls = motion.animate(
    modalPanel,
    {
      opacity: [1, 0],
      transform: ["translateY(0px) scale(1)", "translateY(10px) scale(0.97)"]
    },
    { duration: 0.16, easing: "ease-in" }
  );
  if (controls && controls.finished) {
    await controls.finished;
  }
}

/**
 * Binds subtle hardware-accelerated hover/press micro-interactions using Motion One.
 * @param {HTMLElement|Document} root
 */
export async function bindMicroInteractions(root = document) {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReducedMotion) return;

  const motion = await loadMotion();
  if (!motion || !motion.animate) return;

  const interactiveEls = root.querySelectorAll("[data-motion-btn]");
  interactiveEls.forEach((el) => {
    if (el.dataset.motionBound === "1") return;
    el.dataset.motionBound = "1";

    el.addEventListener("pointerenter", () => {
      if (el.disabled) return;
      motion.animate(el, { transform: "translateY(-1px) scale(1.01)" }, { duration: 0.15 });
    });

    el.addEventListener("pointerleave", () => {
      motion.animate(el, { transform: "translateY(0px) scale(1)" }, { duration: 0.15 });
    });

    el.addEventListener("pointerdown", () => {
      if (el.disabled) return;
      motion.animate(el, { transform: "scale(0.97)" }, { duration: 0.08 });
    });

    el.addEventListener("pointerup", () => {
      if (el.disabled) return;
      motion.animate(el, { transform: "translateY(-1px) scale(1.01)" }, { duration: 0.12 });
    });
  });
}

/**
 * Animates a KPI numeric counter smoothly from 0 to target value.
 * @param {HTMLElement} el
 * @param {number} target
 * @param {function(number): string} [formatter]
 */
export function animateCounter(el, target, formatter = (v) => String(Math.round(v))) {
  if (!el) return;
  const gsap = window.gsap;
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!gsap || prefersReducedMotion) {
    el.textContent = formatter(target);
    return;
  }

  const startVal = Number(el.dataset.lastVal || 0);
  const proxy = { val: startVal };
  el.dataset.lastVal = String(target);

  gsap.to(proxy, {
    val: target,
    duration: 0.55,
    ease: "power2.out",
    onUpdate: () => {
      el.textContent = formatter(proxy.val);
    }
  });
}
