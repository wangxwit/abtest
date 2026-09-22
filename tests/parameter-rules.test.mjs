import test from 'node:test';
import assert from 'node:assert/strict';
import { validateParameterRules } from '../src/coordination.ts';

const candidate = () => ({
  parameterKeys: ['ui.layout', 'ranking.model'],
  variants: [{ name: 'A', value: JSON.stringify({'ui.layout':'classic','ranking.model':'baseline'}) },
    { name: 'B', value: JSON.stringify({'ui.layout':'compact','ranking.model':'v2'}) }],
  parameterRules: [{id:'rule-1',ifKey:'ui.layout',ifValue:'"compact"',thenKey:'ranking.model',thenValue:'"v2"'}]
});
test('business parameter constraints work without endpoint bindings', () => {
  assert.equal(validateParameterRules(candidate()), null);
  const e=candidate(); e.variants[1].value=JSON.stringify({'ui.layout':'compact','ranking.model':'baseline'});
  assert.match(validateParameterRules(e), /B.*违反.*规则/);
});
test('rules only reference explicit experiment parameters and finite typed JSON', () => {
  const e=candidate(); e.parameterRules[0].thenKey='other.key';
  assert.match(validateParameterRules(e), /只能引用/);
  e.parameterRules[0].thenKey='ranking.model'; e.parameterRules[0].ifValue='1e999';
  assert.match(validateParameterRules(e), /有限 JSON/);
  e.parameterRules[0].ifValue='"compact"'; e.parameterRules[0].thenValue='2';
  assert.match(validateParameterRules(e), /违反/);
});
test('constraints cannot silently ignore missing bundle members', () => {
  const e=candidate(); e.variants[1].value='{"ui.layout":"compact"}';
  assert.match(validateParameterRules(e), /完整配置/);
  e.variants[1]=null;
  assert.match(validateParameterRules(e), /JSON/);
});
test('old experiments remain valid without new optional rules', () => {
  assert.equal(validateParameterRules({parameterKeys:[],variants:[]}), null);
  assert.equal(validateParameterRules({parameterRules:[],parameterKeys:[],variants:[{name:'A',value:'{}'},{name:'B',value:'{}'}]}), null);
  assert.match(validateParameterRules({...candidate(),parameterRules:null}), /格式/);
});
