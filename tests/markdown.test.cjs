const {test}=require('node:test'),assert=require('node:assert/strict'),{markdown}=require('../src/renderer/markdown.js');

test('inline formatting',()=>{
 assert.equal(markdown('**bold** *em* _em_ ~~gone~~ `code`'),'<p><strong>bold</strong> <em>em</em> <em>em</em> <del>gone</del> <code>code</code></p>');
 assert.equal(markdown('***both***'),'<p><strong><em>both</em></strong></p>');
 assert.equal(markdown('snake_case_name and 2 * 3'),'<p>snake_case_name and 2 * 3</p>');
});

test('block structure',()=>{
 assert.equal(markdown('# One\n## Two'),'<h3 class="mdh">One</h3><h4 class="mdh">Two</h4>');
 assert.equal(markdown('a\nb\n\nc'),'<p>a<br>b</p><p>c</p>');
 assert.equal(markdown('- a\n- b\n  - nested'),'<ul><li>a</li><li>b<ul><li>nested</li></ul></li></ul>');
 assert.equal(markdown('3. three\n4. four'),'<ol start="3"><li>three</li><li>four</li></ol>');
 assert.equal(markdown('> quoted'),'<blockquote><p>quoted</p></blockquote>');
 assert.equal(markdown('---'),'<hr>');
 assert.equal(markdown('| a | b |\n|---|--:|\n| 1 | 2 |'),'<div class="table-scroll"><table><thead><tr><th>a</th><th class="mdend">b</th></tr></thead><tbody><tr><td>1</td><td class="mdend">2</td></tr></tbody></table></div>');
});

test('fenced code keeps its contents verbatim',()=>{
 assert.equal(markdown('```js\nif (a < b && c) {}\n```'),'<pre class="mdcode" data-lang="js"><code>if (a &lt; b &amp;&amp; c) {}</code></pre>');
 assert.equal(markdown('```\n**not bold**\n```'),'<pre class="mdcode"><code>**not bold**</code></pre>');
 assert.match(markdown('```py\nprint(1)'),/^<pre class="mdcode" data-lang="py"><code>print\(1\)<\/code><\/pre>$/);
});

test('markup in the answer is never live',()=>{
 for(const attack of ['<img src=x onerror=alert(1)>','<script>alert(1)</script>','<div onclick="x">hi</div>','[x](javascript:alert(1))','[x](data:text/html,<script>1</script>)','![x](vbscript:1)','<a href="https://evil.example">link</a>']){
  const html=markdown(attack);
  assert.equal(/<(?!\/?(p|br|strong|em|del|code|pre|h[3-6]|ul|ol|li|blockquote|hr|table|thead|tbody|tr|th|td|div class="table-scroll"|a class="mdlink")[ >])/.test(html),false,attack+' -> '+html);
  assert.equal(html.includes('onerror'),html.includes('&lt;img'),attack);
  assert.equal(/href="(?!https?:)/.test(html),false,attack);
 }
});

test('only http and https links become anchors',()=>{
 assert.equal(markdown('[a](https://ok.example)'),'<p><a class="mdlink" href="https://ok.example/" data-link="https://ok.example/">a</a></p>');
 assert.equal(markdown('[a](ftp://no.example)'),'<p>[a](ftp://no.example)</p>');
 assert.match(markdown('see https://ok.example/x?a=1&b=2 now'),/href="https:\/\/ok\.example\/x\?a=1&amp;b=2"/);
 assert.equal(markdown('mail me at me@example.com'),'<p>mail me at me@example.com</p>');
});

test('empty and non-string input',()=>{
 for(const v of ['','   ','\n\n',null,undefined])assert.equal(markdown(v),'');
});
