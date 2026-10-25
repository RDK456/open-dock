const els = document.querySelectorAll('.reveal');
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

if (window.gsap && window.ScrollTrigger && !still) {
  document.documentElement.classList.add('gs');
  gsap.registerPlugin(ScrollTrigger);
  gsap.from('.hero .phone', { opacity: 0, y: 60, rotate: -3, scale: 0.92, duration: 1.3, ease: 'power3.out' });
  ScrollTrigger.batch('.reveal', {
    start: 'top 88%',
    once: true,
    onEnter: (b) => gsap.from(b, { opacity: 0, scale: 0.9, y: 24, duration: 0.9, ease: 'back.out(1.4)', stagger: 0.08, clearProps: 'transform' }),
  });
} else if ('IntersectionObserver' in window && !still) {
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { threshold: 0.12 });
  els.forEach((el) => io.observe(el));
} else els.forEach((el) => el.classList.add('in'));
