#!/usr/bin/env python3
"""Assemble the 6 generated sections into one complete index.html."""
from pathlib import Path

BASE = Path.home() / "workspace" / "your_files" / "agency-portfolio"
ORDER = ["01-hero", "02-services", "03-portfolio", "04-process", "05-why-faq", "06-contact"]

sections = []
for name in ORDER:
    p = BASE / name / "output.md"
    html = p.read_text(encoding="utf-8").strip()
    assert html, f"empty section {name}"
    assert "```" not in html, f"fences leaked in {name}"
    sections.append(f"<!-- ===== {name} ===== -->\n{html}")

GSAP_INIT = r"""
<script>
gsap.registerPlugin(ScrollTrigger);

// Fade-up reveals on scroll
gsap.utils.toArray('[data-reveal]').forEach(function (el) {
  gsap.from(el, {
    y: 40, opacity: 0, duration: 0.9, ease: 'power3.out',
    delay: parseFloat(el.dataset.revealDelay || 0),
    scrollTrigger: { trigger: el, start: 'top 88%', once: true }
  });
});

// Animated counters
gsap.utils.toArray('[data-counter]').forEach(function (el) {
  var target = parseFloat(el.dataset.count || 0);
  var obj = { v: 0 };
  ScrollTrigger.create({
    trigger: el, start: 'top 90%', once: true,
    onEnter: function () {
      gsap.to(obj, {
        v: target, duration: 1.6, ease: 'power2.out',
        onUpdate: function () { el.textContent = Math.round(obj.v); }
      });
    }
  });
});

// Magnetic buttons (fine pointers only)
if (window.matchMedia('(pointer: fine)').matches) {
  gsap.utils.toArray('[data-magnetic]').forEach(function (el) {
    el.addEventListener('mousemove', function (e) {
      var r = el.getBoundingClientRect();
      gsap.to(el, {
        x: (e.clientX - r.left - r.width / 2) * 0.25,
        y: (e.clientY - r.top - r.height / 2) * 0.25,
        duration: 0.4, ease: 'power3.out'
      });
    });
    el.addEventListener('mouseleave', function () {
      gsap.to(el, { x: 0, y: 0, duration: 0.6, ease: 'elastic.out(1, 0.4)' });
    });
  });
}

// Subtle parallax
gsap.utils.toArray('[data-parallax]').forEach(function (el) {
  gsap.to(el, {
    yPercent: parseFloat(el.dataset.parallax || 0.15) * 100, ease: 'none',
    scrollTrigger: {
      trigger: el.closest('section') || el,
      start: 'top bottom', end: 'bottom top', scrub: true
    }
  });
});

// Scroll-scrubbed progress lines
gsap.utils.toArray('[data-scrub]').forEach(function (el) {
  gsap.fromTo(el, { scaleX: 0 }, {
    scaleX: 1, ease: 'none', transformOrigin: 'left center',
    scrollTrigger: {
      trigger: el.closest('section') || el,
      start: 'top 70%', end: 'bottom 60%', scrub: true
    }
  });
});
</script>
"""

page = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mr.Blues Tech — Websites, Data &amp; Automation That Actually Work</title>
<meta name="description" content="Mr.Blues Tech is a web services agency serving local and global clients: bulk web data extraction, landing pages & websites, browser automation & AI tools, AI content & media. Human QA on every delivery.">
<script src="https://cdn.tailwindcss.com"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/ScrollTrigger.min.js"></script>
<style>
  html {{ scroll-behavior: smooth; }}
  body {{ font-family: 'Inter', system-ui, sans-serif; background: #0B0F19; }}
  ::selection {{ background: #4ADE80; color: #0B0F19; }}
</style>
</head>
<body class="bg-[#0B0F19] text-[#F8FAFC] antialiased overflow-x-hidden">

{chr(10).join(sections)}

{GSAP_INIT}
</body>
</html>
"""

out = Path.home() / "workspace" / "agency-portfolio" / "index.html"
out.write_text(page, encoding="utf-8")
print(f"wrote {out} ({out.stat().st_size} bytes)")
