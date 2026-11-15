// TEST DOUBLE - this is NOT lottie-web.
//
// The real runtime (assets/vendor/lottie/lottie_svg.min.js, official lottie-web, SVG renderer) is a ~300 KB third-party file that
// is vendored by android-build/vendor-lottie.mjs. The splash tests only need to prove how app/js/splash.js DRIVES a Lottie runtime
// (when it starts it, when it releases the native splash, what it waits for, how it reacts to failures), so they serve this tiny
// stand-in with the same surface the splash uses: lottie.loadAnimation() -> addEventListener / play / goToAndStop / destroy.
// It draws no animation - only an <svg> with the composition's viewBox so that sizing and aspect-ratio can be measured.
//
// Scenario switches come from window.__LOTTIE_STUB__ (set by the test with addInitScript):
//   mode: 'ok' (default) | 'throw' (loadAnimation throws) | 'neverLoaded' (no DOMLoaded) | 'noComplete' (never completes)
//         | 'renderError' (fires "error" while playing)
//   duration: how long play() takes before "complete" (ms, default 600)
// Everything the splash does is recorded in window.__lottie = { calls, events }.
(function(){
  var cfg = window.__LOTTIE_STUB__ || {};
  var log = window.__lottie = { calls: [], events: [] };
  function ev(name, extra){ log.events.push({ name: name, t: Math.round(performance.now()), extra: extra || null }); }

  window.lottie = {
    loadAnimation: function(opts){
      var data = opts.animationData || {};
      var rs = opts.rendererSettings || {};
      log.calls.push({
        renderer: opts.renderer, loop: opts.loop, autoplay: opts.autoplay,
        container: !!(opts.container && opts.container.nodeType === 1),
        w: data.w, h: data.h, fr: data.fr, ip: data.ip, op: data.op, layers: (data.layers || []).length,
        preserveAspectRatio: rs.preserveAspectRatio
      });
      ev('loadAnimation');
      if(cfg.mode === 'throw') throw new Error('stub: loadAnimation failed');

      var NS = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('xmlns', NS);
      svg.setAttribute('viewBox', '0 0 ' + data.w + ' ' + data.h);
      svg.setAttribute('preserveAspectRatio', rs.preserveAspectRatio || 'xMidYMid meet');
      svg.setAttribute('width', data.w); svg.setAttribute('height', data.h);
      svg.style.width = '100%'; svg.style.height = '100%';
      svg.innerHTML = '<rect width="' + data.w + '" height="' + data.h + '" fill="#fff"/>' +
                      '<rect id="stub-bounds" x="4" y="4" width="' + (data.w - 8) + '" height="' + (data.h - 8) + '" fill="none" stroke="#0a7f5a" stroke-width="8"/>';
      opts.container.appendChild(svg);

      var listeners = {}, destroyed = false;
      var item = {
        totalFrames: (data.op - data.ip) || 0,
        isLoaded: cfg.mode !== 'neverLoaded',
        addEventListener: function(name, fn){ (listeners[name] = listeners[name] || []).push(fn); },
        removeEventListener: function(){},
        trigger: function(name){ (listeners[name] || []).slice().forEach(function(fn){ try{ fn({ type: name }); }catch(e){} }); },
        play: function(){
          ev('play');
          if(cfg.mode === 'noComplete') return;
          if(cfg.mode === 'renderError'){ setTimeout(function(){ if(!destroyed) item.trigger('error'); }, 50); return; }
          setTimeout(function(){ if(destroyed) return; ev('complete'); item.trigger('complete'); }, cfg.duration == null ? 600 : cfg.duration);
        },
        goToAndStop: function(v, isFrame){ ev('goToAndStop', { v: v, isFrame: !!isFrame }); },
        destroy: function(){ destroyed = true; ev('destroy'); if(svg.parentNode) svg.parentNode.removeChild(svg); }
      };
      setTimeout(function(){
        if(destroyed || cfg.mode === 'neverLoaded') return;
        ev('DOMLoaded');
        item.trigger('DOMLoaded');
      }, 0);
      return item;
    }
  };
  window.bodymovin = window.lottie;
})();
