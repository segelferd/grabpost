(function () {
  var D = JSON.parse(document.getElementById('demo-data').textContent);
  var RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* hero demo: Download -> Downloading -> Downloaded, the picture flies into the folder */
  var demo = document.querySelector('.demo');
  if (demo) {
    var btn = demo.querySelector('.gp');
    var label = btn.querySelector('.lbl');
    var folder = demo.querySelector('.folder');
    var count = folder.querySelector('.count');
    var pics = D.pics, i = 0, saved = 0, timer = null;
    var img = demo.querySelector('.pic img');
    var ttl = demo.querySelector('.ttl');
    var setIdle = function () {
      btn.className = 'gp nudge'; btn.disabled = false;
      label.textContent = D.idle;
    };
    var fly = function () {
      if (RM) return;
      var a = img.getBoundingClientRect(), b = folder.getBoundingClientRect();
      var chip = document.createElement('div');
      chip.className = 'chip';
      chip.innerHTML = '<img alt="" src="' + img.src + '">';
      chip.style.left = (a.left + a.width / 2 - 28) + 'px';
      chip.style.top = (a.top + a.height / 2 - 19) + 'px';
      document.body.appendChild(chip);
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          var dx = b.left + 24 - (a.left + a.width / 2 - 28), dy = b.top + 2 - (a.top + a.height / 2 - 19);
          chip.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(.35)';
          chip.style.opacity = '0';
        });
      });
      setTimeout(function () { chip.remove(); }, 800);
    };
    btn.addEventListener('click', function () {
      if (btn.classList.contains('loading') || btn.classList.contains('done')) return;
      btn.className = 'gp loading'; label.textContent = D.loading;
      setTimeout(function () {
        btn.className = 'gp done'; label.textContent = D.done;
        fly();
        setTimeout(function () {
          saved++; count.textContent = saved;
          folder.classList.remove('pop'); void folder.offsetWidth; folder.classList.add('pop');
        }, RM ? 0 : 650);
        clearTimeout(timer);
        timer = setTimeout(next, 2600);
      }, RM ? 200 : 1600);
    });
    var next = function () {
      i = (i + 1) % pics.length;
      img.src = pics[i].src; ttl.textContent = pics[i].t;
      demo.querySelector('.hd b').textContent = 'r/' + pics[i].s;
      demo.querySelector('.folder span').textContent = D.folder + pics[i].s;
      setIdle();
    };
    demo.querySelector('.replay').addEventListener('click', function () { clearTimeout(timer); next(); });
    setIdle();
  }

  /* screenshots fade in when they scroll into view */
  if ('IntersectionObserver' in window && !RM) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -10% 0px' });
    document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('in'); });
  }

  /* language menu closes on outside click */
  var langs = document.querySelector('.langs');
  if (langs) document.addEventListener('click', function (e) { if (!langs.contains(e.target)) langs.removeAttribute('open'); });
})();
