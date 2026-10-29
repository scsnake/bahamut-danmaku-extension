// privacy.js
//
// Shows PRIVACY.md (shipped with the extension) as a page, so the policy
// that is linked from the extension is always the one it was built with.
// Handles only the Markdown that file uses: #/##/### headings, "- " lists,
// paragraphs, "---", **bold**, `code` and [text](https://…) links. Built
// with DOM calls, so nothing in the file becomes markup.

fetch(chrome.runtime.getURL('PRIVACY.md'))
  .then(res => res.text())
  .then(render)
  .catch(err => {
    document.getElementById('policy').textContent = `Could not load the policy: ${err}`;
  });

function render(md) {
  const main = document.getElementById('policy');
  const text = md.replace(/<!--[\s\S]*?-->/g, '');
  let list = null;
  let para = [];
  const flush = () => {
    if (para.length) main.appendChild(inline(document.createElement('p'), para.join(' ')));
    para = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (!line.startsWith('- ')) list = null;
    if (heading) {
      flush();
      const h = inline(document.createElement(`h${heading[1].length}`), heading[2]);
      main.appendChild(h);
      if (heading[1].length === 1) document.title = h.textContent;
    } else if (line.startsWith('- ')) {
      flush();
      if (!list) list = main.appendChild(document.createElement('ul'));
      list.appendChild(inline(document.createElement('li'), line.slice(2)));
    } else if (line === '---') {
      flush();
      main.appendChild(document.createElement('hr'));
    } else if (!line) {
      flush();
    } else {
      para.push(line);
    }
  }
  flush();
}

// Appends `text` to `el`, with **bold**, `code` and https links.
function inline(el, text) {
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    el.append(text.slice(last, m.index));
    if (m[1] !== undefined) {
      el.appendChild(document.createElement('strong')).textContent = m[1];
    } else if (m[2] !== undefined) {
      el.appendChild(document.createElement('code')).textContent = m[2];
    } else {
      const a = el.appendChild(document.createElement('a'));
      a.href = m[4];
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = m[3];
    }
    last = m.index + m[0].length;
  }
  el.append(text.slice(last));
  return el;
}
