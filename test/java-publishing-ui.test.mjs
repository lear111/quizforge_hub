import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadForm,uploadDone} from '../java-hub/src/main/resources/static/publishing-ui.mjs';
import {detail} from '../java-hub/src/main/resources/static/catalog-view.mjs';
test('publishing form has real required input, explicit rights and supported file constraints',()=>{
  const html=uploadForm();assert.match(html,/name="title"[^>]*required/);assert.match(html,/name="description"[^>]*required/);assert.match(html,/name="rights" required/);assert.match(html,/\.qbank,\.zip,\.7z,\.rar/);assert.match(html,/image\/png,image\/jpeg,image\/webp/);assert.doesNotMatch(html,/setTimeout|已上传|尚在迁移/);
});
test('editing escapes stored text, preserves long descriptions and accurately states pending behavior',()=>{
  const html=uploadForm({title:'"<img src=x>',description:'</textarea><script>bad</script>'+ '长'.repeat(600),version:'" autofocus x="'});assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('长'.repeat(600)));assert.doesNotMatch(html,/<script>|<img src=x>|autofocus x="/);assert.match(html,/审核期间暂停公开/);
});
test('saved pending confirmation escapes metadata and links to saved entry',()=>{
  const html=uploadDone({id:'synthetic',title:'<svg>'});assert.match(html,/已提交，等待审核/);assert.match(html,/href="#mine"/);assert.ok(html.includes('&lt;svg&gt;'));assert.doesNotMatch(html,/<svg>/);
});
test('only owner gets native edit link; administrator does not silently gain owner edit',()=>{
  const pack={id:'synthetic',title:'t',user_id:'owner',status:'pending',screenshots:[],tags:[]},config={native:['publishing-edit']};assert.match(detail(pack,[],config,{id:'owner',admin:0}),/href="#edit\/synthetic"/);assert.doesNotMatch(detail(pack,[],config,{id:'other',admin:1}),/href="#edit\/synthetic"/);
});
