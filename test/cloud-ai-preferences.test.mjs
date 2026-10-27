import test from 'node:test';
import assert from 'node:assert/strict';
import {readCloudAiPrefs} from '../practice/public/cloud/ai-preferences.js';
const fresh={enabled:true,autoGrade:true,useOfficial:true,useCustom:false};
const off={enabled:false,autoGrade:false,useOfficial:false,useCustom:false};
const storage=values=>({getItem:key=>Object.hasOwn(values,key)?values[key]:null});
test('first cloud visit defaults to enabled automatic free-quota grading without persisting or enabling a custom model',()=>{
 const values={};assert.deepEqual(readCloudAiPrefs(storage(values),'alice'),fresh);assert.deepEqual(values,{});assert.deepEqual(readCloudAiPrefs(storage(values),null),off);
});
test('saved disabled or manual settings win and account preferences stay isolated',()=>{
 const choice={...fresh,enabled:false,autoGrade:false,useOfficial:false,useCustom:true},s=storage({'qfh.ai.prefs.v1:alice':JSON.stringify(choice)});
 assert.deepEqual(readCloudAiPrefs(s,'alice'),choice);assert.deepEqual(readCloudAiPrefs(s,'bob'),fresh);
 assert.deepEqual(readCloudAiPrefs(storage({'qfh.ai.prefs.v1:alice':'{}'}),'alice'),off);
});
test('old custom-model preferences are preserved and broken storage does not unexpectedly start free grading',()=>{
 assert.deepEqual(readCloudAiPrefs(storage({'qfh.ai.v1:alice':'{"enabled":false,"autoGrade":false}'}),'alice'),{...off,useCustom:true});
 assert.deepEqual(readCloudAiPrefs(storage({'qfh.ai.v1:alice':'{"enabled":true,"autoGrade":true}'}),'alice'),{...fresh,useOfficial:false,useCustom:true});
 for(const value of ['not json','null','[]'])assert.deepEqual(readCloudAiPrefs(storage({'qfh.ai.prefs.v1:alice':value}),'alice'),off);
 assert.deepEqual(readCloudAiPrefs({getItem(){throw Error('blocked');}},'alice'),off);
});
