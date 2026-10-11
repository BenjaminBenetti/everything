/* Motion decorates synchronous navigation: no delayed state changes or blocked input. */
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const easing = 'cubic-bezier(.22, 1, .36, 1)';
  let current;

  function finish() {
    if (!current) return;
    current.animations.forEach(animation => animation.cancel());
    current.layers.forEach(layer => layer.remove());
    delete document.documentElement.dataset.motion;
    current = null;
  }

  function animate(run, element, frames, duration, delay = 0, curve = easing) {
    if (!element) return;
    const animation = element.animate(frames, {duration, delay, easing:curve, fill:'both'});
    run.animations.push(animation);
    return animation;
  }

  function layer(run, rect, cls) {
    const el = document.createElement('div');
    el.className = `motion-layer ${cls}`;
    el.setAttribute('aria-hidden', 'true');
    el.inert = true;
    Object.assign(el.style, {left:`${rect.left}px`, top:`${rect.top}px`, width:`${rect.width}px`, height:`${rect.height}px`});
    document.body.append(el);
    run.layers.push(el);
    return el;
  }

  function snapshot(run, element, cls) {
    if (!element) return null;
    const el = layer(run, element.getBoundingClientRect(), cls);
    const copy = element.cloneNode(true);
    copy.removeAttribute('id');
    copy.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    copy.querySelectorAll('input[type="password"]').forEach(input => {input.value = ''; input.removeAttribute('value');});
    copy.classList.add('motion-copy');
    el.append(copy);
    const originalScrollers = element.querySelectorAll('.messages, .content, .sidepanel');
    copy.querySelectorAll('.messages, .content, .sidepanel').forEach((node, index) => {node.scrollTop = originalScrollers[index].scrollTop;});
    return el;
  }

  function signIn(run, old, update) {
    const art = old && [...old.querySelectorAll('.theme-art')].find(el=>el.getBoundingClientRect().width>0);
    const grid = art?.querySelector('.art-grid');
    const route = grid?.querySelectorAll(':scope > path')[1];
    if (!route) {update();animate(run, old, [{opacity:1},{opacity:0}], 300);return;}

    // Keep the artwork in place. Preserve its resting opacity while lighting only the existing route.
    grid.style.opacity = getComputedStyle(art).opacity;
    art.style.opacity = '1';
    const light = route.cloneNode();
    light.setAttribute('class','login-route-light');
    light.setAttribute('pathLength','1');
    light.setAttribute('stroke','currentColor');
    art.querySelector('svg').append(light);
    update();

    animate(run,light,[{strokeDashoffset:1,opacity:0},{opacity:1,offset:.14},{strokeDashoffset:0,opacity:.88}],640,70,'ease-in-out');
    // Reveal Home only after the line finishes; the page and grid remain stationary throughout.
    animate(run,old,[{opacity:1},{opacity:0}],300,710,'ease-in-out');
    animate(run,document.querySelector('#root .shell'),[{opacity:0},{opacity:1}],300,710,'ease-in-out');
  }

  function content(run, old, update, direction) {
    update();
    const next = document.querySelector('#root .main, #root .login');
    if (!next) return;
    const distance = innerWidth <= 650 ? 38 : 64;
    // Animate inside stationary clipping frames; moving the frames grows document overflow.
    [...next.children].forEach(child => {
      animate(run, child, [{opacity:0, transform:`translateX(${direction*distance}px)`}, {opacity:1, transform:'translateX(0)'}], 420, 45, 'cubic-bezier(.25, .75, .25, 1)');
    });
    animate(run, old?.querySelector('.motion-copy'), [{opacity:1, transform:'translateX(0)'}, {opacity:0, transform:`translateX(${-direction*distance*.65}px)`}], 220, 0, 'cubic-bezier(.4, 0, .6, 1)');

  }

  function transition(update, {kind='content', direction=1} = {}) {
    finish();
    if (reduce.matches || !Element.prototype.animate) {update(); return;}
    const run = {animations:[], layers:[]};
    current = run;
    try {
      const target = document.querySelector(kind==='signin' ? '#root .login' : '#root .main, #root .login');
      const old = snapshot(run, target, kind==='signin' ? 'motion-login' : 'motion-outgoing');
      document.documentElement.dataset.motion = kind;
      if (kind==='signin') signIn(run, old, update);
      else content(run, old, update, direction);
    } catch (error) {
      // A decoration failure must never trap the user on the previous screen.
      finish();
      update();
      return;
    }
    Promise.allSettled(run.animations.map(animation => animation.finished)).then(() => {if(current===run)finish();});
  }

  function enter(element, kind='dialog') {
    if (!element || reduce.matches || !Element.prototype.animate) return;
    return element.animate([{opacity:0, transform:kind==='panel'?'translateX(16px)':'translateY(8px) scale(.985)'}, {opacity:1, transform:'none'}], {duration:220, easing});
  }
  reduce.addEventListener('change', () => {if(reduce.matches)finish();});
  window.addEventListener('resize', finish);
  window.EverythingMotion = {transition, enter, finish};
})();
