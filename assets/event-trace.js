/* A minimal synchronous teaching emitter; trace playback is separate from execution. */
(() => {
  const root = document.querySelector('[data-event-trace]');
  if (!root) return;
  const order = root.querySelector('[data-order]');
  const code = root.querySelector('[data-code]');
  const previous = root.querySelector('[data-prev]');
  const next = root.querySelector('[data-next]');
  const reset = root.querySelector('[data-reset]');
  let late = false;
  let position = 0;
  let trace = [];
  const common = ['function show(text) {', '  output.push(text);', '}'];
  function buildTrace() {
    let registered = false;
    let delivered = false;
    const output = [];
    const frames = [];
    const record = (line, heading, detail) => frames.push({ line, heading, detail, registered, delivered, output: [...output] });
    const listeners = new Map();
    const bus = {
      on(name, listener) {
        listeners.set(name, [...(listeners.get(name) || []), listener]);
        registered = true;
        record(late ? 7 : 4, '登记完成，函数还没有执行', late ? '现在才登记 text → show。这个教学实现不保存旧事件，因此不会补送刚才的“你好”。' : '第 4 行只把 text → show 记进订阅表。show 的函数体还没有执行，所以输出仍为空。');
      },
      emit(name, value) {
        record(late ? 5 : 6, '发出 text 事件，携带“你好”', registered ? '按事件名查订阅表，找到了 show。下一步进入它的函数体，不是直接走到 B。' : '此刻订阅表是空的，没有函数接收这条消息。下一步继续输出 B。');
        for (const listener of listeners.get(name) || []) listener(value);
      },
    };
    function show(text) {
      output.push(text);
      delivered = true;
      record(2, '执行位置跳进 show', '“你好”被传给参数 text，执行第 2 行。这里的同步处理函数执行完后，emit 才返回。');
    }
    record(0, '从函数已经定义好的位置开始', '定义 show 只是准备好一个函数。点“下一步”，观察哪个位置先执行。');
    if (!late) bus.on('text', show);
    output.push('A');
    record(late ? 4 : 5, '输出 A', '这是一条普通语句：把 A 加到输出列表，然后继续往下执行。');
    bus.emit('text', '你好');
    output.push('B');
    record(late ? 6 : 7, '继续原来的位置，输出 B', late ? 'emit 没找到接收者，已经返回。现在输出 B；后面才会登记订阅。' : 'show 已执行完成，emit 返回，最后输出 B。实际顺序是 A → 你好 → B。');
    if (late) bus.on('text', show);
    return frames;
  }
  function configure() {
    const lines = late ? [...common, 'output.push("A");', 'bus.emit("text", "你好");', 'output.push("B");', 'bus.on("text", show);'] : [...common, 'bus.on("text", show);', 'output.push("A");', 'bus.emit("text", "你好");', 'output.push("B");'];
    code.replaceChildren(...lines.map((line, index) => {
      const row = document.createElement('div');
      row.className = 'code-line';
      row.dataset.line = String(index + 1);
      const number = document.createElement('span');
      number.className = 'ln';
      number.textContent = String(index + 1);
      const text = document.createElement('code');
      text.textContent = line;
      row.append(number, text);
      return row;
    }));
    trace = buildTrace();
    position = 0;
    render();
  }
  function render() {
    const frame = trace[position];
    code.querySelectorAll('[data-line]').forEach(row => {
      const active = Number(row.dataset.line) === frame.line;
      row.classList.toggle('active', active);
      if (active) row.setAttribute('aria-current', 'step'); else row.removeAttribute('aria-current');
    });
    root.querySelector('[data-heading]').textContent = frame.heading;
    root.querySelector('[data-detail]').textContent = frame.detail;
    root.querySelector('[data-registry]').textContent = frame.registered ? 'text → show' : '尚未登记';
    root.querySelector('[data-delivery]').textContent = frame.delivered ? 'show 已执行' : 'show 尚未执行';
    const out = root.querySelector('[data-output]');
    out.replaceChildren();
    (frame.output.length ? frame.output : ['还没有输出']).forEach(value => {
      const token = document.createElement('span');
      token.textContent = value;
      if (!frame.output.length) token.className = 'empty';
      out.append(token);
    });
    root.querySelector('[data-position]').textContent = `${position} / ${trace.length - 1}`;
    previous.disabled = position === 0;
    next.disabled = position === trace.length - 1;
    next.textContent = next.disabled ? '这一遍结束' : '下一步 →';
    order.textContent = late ? '换回：先登记' : '换个顺序：后登记';
    root.querySelector('[data-mode]').textContent = late ? '先发出 · 后登记' : '先登记 · 后发出';
  }
  previous.addEventListener('click', () => { if (position > 0) { position--; render(); } });
  next.addEventListener('click', () => { if (position < trace.length - 1) { position++; render(); } });
  reset.addEventListener('click', () => { position = 0; render(); });
  order.addEventListener('click', () => { late = !late; configure(); });
  configure();
})();
