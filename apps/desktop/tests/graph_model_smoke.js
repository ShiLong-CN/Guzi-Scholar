'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const GraphModel = require('../web/graph-model.js');
const GraphView = require('../web/graph-view.js');

function metadata(fields) {
  return { fields: { authors: [], keywords: [], ...fields } };
}

function item(fields, values = {}, extra = {}) {
  return {
    folder_ids: [],
    values: { reading_status: '未开始', importance: 0, research_topic: [], venue: '', ...values },
    metadata: metadata(fields),
    progress: { percent: 0 },
    deleted_at: null,
    ...extra,
  };
}

const snapshot = {
  version: 4,
  folders: [
    { id: 'system-all', name: '全部文献', system: true },
    { id: 'folder-foundation', name: '基础模型', system: false },
  ],
  properties: [
    { id: 'reading_status', label: '阅读状态', type: 'select', system: true },
    { id: 'importance', label: '重要程度', type: 'rating', system: true },
    { id: 'research_topic', label: '研究主题', type: 'multi-select', system: true },
    { id: 'venue', label: '接收/来源', type: 'text', system: true },
    { id: 'domain', label: '领域', type: 'multi-select', system: false, hidden: false },
    { id: 'method', label: '方法', type: 'select', system: false, hidden: false },
    { id: 'notes', label: '备注', type: 'text', system: false, hidden: false },
    { id: 'confidence', label: '置信度', type: 'rating', max: 5, system: false, hidden: false },
  ],
  items: {
    alpha: item({
      title: 'Multimodal Language Model Alignment',
      abstract: 'A unified vision encoder aligns multimodal inputs with a large language model.',
      keywords: ['multimodal learning', 'language model'],
      authors: ['Alice Zhang'],
      year: 2024,
      venue: 'Advances in Neural Information Processing Systems 36',
    }, {
      reading_status: '阅读中',
      importance: 4,
      research_topic: ['大模型', '多模态'],
      domain: ['基础模型', 'Vision'],
      method: 'Adapter',
      notes: '  可解释   关系  ',
      confidence: 3,
    }, { folder_ids: ['folder-foundation'], progress: { percent: 42.25 } }),
    beta: item({
      title: 'Multimodal Language Model Routing',
      abstract: 'A vision encoder routes multimodal inputs into a unified large language model.',
      keywords: ['multimodal learning', 'language model'],
      authors: ['Alice Zhang', 'Bob Li'],
      year: 2024,
      venue: 'Advances in Neural Information Processing Systems 37',
    }, {
      reading_status: '已完成',
      importance: 2,
      research_topic: ['大模型'],
      domain: ['基础模型'],
      method: 'Router',
      notes: '可解释 关系',
      confidence: 3,
    }, { folder_ids: ['folder-foundation'], progress: { percent: 12 } }),
    gamma: item({
      title: 'Protein Structure Search',
      abstract: 'Protein folding is evaluated with amino acid structure retrieval.',
      keywords: ['protein folding'],
      authors: ['Carol Wu'],
      year: 2023,
      venue: '2023 IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)',
    }, { research_topic: [], domain: [], method: '', notes: '长'.repeat(81), confidence: 0 }),
    empty: item({ title: '', abstract: '', authors: [], keywords: [], year: null, venue: '' }, {
      research_topic: ['', '   '],
      domain: [],
      method: '',
    }),
    deleted: item({
      title: 'Deleted Multimodal Language Model',
      abstract: 'multimodal language model vision encoder',
      venue: 'Advances in Neural Information Processing Systems 35',
    }, { research_topic: ['大模型'], domain: ['基础模型'] }, { deleted_at: '2026-01-01T00:00:00Z' }),
  },
};

function dataById(graph, id) {
  return graph.nodes.find((node) => node.data.id === id)?.data;
}

function edgesOfType(graph, type) {
  return graph.edges.filter((edge) => edge.data.type === type);
}

assert.equal(GraphModel.normalizeVenue('Advances in Neural Information Processing Systems 35'), 'NeurIPS');
assert.equal(GraphModel.normalizeVenue('Advances in Neural Information Processing Systems 37'), 'NeurIPS');
assert.equal(GraphModel.normalizeVenue('2024 IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)'), 'CVPR');
assert(GraphModel.tokenize('大模型研究').includes('模型'));
assert(GraphModel.tokenize('大模型研究').includes('研究'));
assert(!GraphModel.tokenize('the model and method').includes('the'));

const graph = GraphModel.buildGraph(snapshot);
assert.equal(graph.stats.paperCount, 4, '回收站文献必须被排除');
assert(!dataById(graph, 'paper:deleted'));
assert.equal(graph.config.showSimilarity, true);
assert.equal(graph.config.showAttributes, true);
assert.equal(graph.config.topK, 2);
assert.equal(graph.config.similarityThreshold, 0);
assert.deepEqual(graph.config.attributeIds, ['research_topic', 'venue', 'domain', 'method']);

const alpha = dataById(graph, 'paper:alpha');
assert.equal(alpha.readingStatus, '阅读中');
assert.equal(alpha.importance, 4);
assert.equal(Object.hasOwn(alpha, 'progress'), false, '关系图谱不得继续读取已退役的百分比进度');
assert(alpha.size > dataById(graph, 'paper:beta').size);
assert(alpha.size >= 31 && alpha.size <= 36, '文献节点尺寸必须保持在紧凑范围内');
assert(dataById(graph, 'paper:empty').size >= 31 && dataById(graph, 'paper:empty').size <= 36, '低重要度文献不能缩得过小');
assert(alpha.size - dataById(graph, 'paper:empty').size <= 5, '重要度造成的尺寸跨度不能超过 5px');
assert.match(alpha.statusColor, /^#/);
assert.equal(Object.hasOwn(dataById(graph, 'paper:beta'), 'progress'), false, '已完成状态也不应恢复百分比进度字段');

const topicNode = graph.nodes.find((node) => node.data.type === 'attribute' && node.data.propertyId === 'research_topic' && node.data.value === '大模型')?.data;
assert(topicNode, '缺少研究主题节点');
assert.equal(topicNode.paperCount, 2, '相同属性值应合并为一个节点');
assert.deepEqual(new Set(topicNode.jobIds), new Set(['alpha', 'beta']));

const venueNodes = graph.nodes.filter((node) => node.data.type === 'attribute' && node.data.propertyId === 'venue');
const neurips = venueNodes.find((node) => node.data.value === 'NeurIPS')?.data;
assert.equal(neurips?.paperCount, 2, 'NeurIPS 35/36/37 等卷号不应分裂会议节点');
assert(neurips.size >= 36 && neurips.size <= 40, '属性节点尺寸必须保持在紧凑范围内');
assert(venueNodes.some((node) => node.data.value === 'CVPR'));

const customDomain = graph.nodes.find((node) => node.data.type === 'attribute' && node.data.propertyId === 'domain' && node.data.value === '基础模型')?.data;
assert.equal(customDomain?.paperCount, 2, '用户 multi-select 属性应生成节点');
assert(graph.nodes.some((node) => node.data.propertyId === 'method' && node.data.value === 'Adapter'), '用户 select 属性应生成节点');
assert(!graph.nodes.some((node) => node.data.propertyId === 'notes'), '高基数 text 属性不应默认生成节点');
assert(!graph.nodes.some((node) => node.data.propertyId === 'confidence'), 'rating 属性不应默认生成节点');
assert(!graph.nodes.some((node) => node.data.type === 'attribute' && !node.data.value.trim()), '空属性值必须被排除');
assert(!graph.edges.some((edge) => edge.data.source === 'paper:deleted' || edge.data.target === 'paper:deleted'));

const similarityEdges = edgesOfType(graph, 'similarity');
const alphaBeta = similarityEdges.find((edge) => new Set([edge.data.source, edge.data.target]).has('paper:alpha') && new Set([edge.data.source, edge.data.target]).has('paper:beta'));
assert(alphaBeta, '内容近似文献之间应生成相似边');
assert(alphaBeta.data.score >= graph.stats.effectiveThreshold);
assert(alphaBeta.data.sharedTokens.length > 0);
assert(alphaBeta.data.reasons.some((reason) => alphaBeta.data.sharedTokens.some((token) => reason.includes(token))), '相似边解释应包含共享词');

const optionalAttributes = GraphModel.buildGraph(snapshot, {
  showSimilarity: false,
  attributeIds: ['folders', 'authors', 'year'],
});
assert.equal(optionalAttributes.stats.similarityEdgeCount, 0);
assert(optionalAttributes.nodes.some((node) => node.data.propertyId === 'folders' && node.data.value === '基础模型'));
assert(optionalAttributes.nodes.some((node) => node.data.propertyId === 'authors' && node.data.value === 'Alice Zhang'));
assert(optionalAttributes.nodes.some((node) => node.data.propertyId === 'year' && node.data.value === '2024'));

const explicitCustomValues = GraphModel.buildGraph(snapshot, {
  showSimilarity: false,
  attributeIds: ['notes', 'confidence'],
});
const exactTextNode = explicitCustomValues.nodes.find((node) => node.data.propertyId === 'notes' && node.data.value === '可解释 关系')?.data;
assert.equal(exactTextNode?.paperCount, 2, '显式开启的 text 属性应按规范化后的精确值合并');
assert(!explicitCustomValues.nodes.some((node) => node.data.propertyId === 'notes' && [...node.data.value].length > 80), '超过 80 字符的 text 值应跳过');
const ratingNode = explicitCustomValues.nodes.find((node) => node.data.propertyId === 'confidence' && node.data.value === '3 星')?.data;
assert.equal(ratingNode?.paperCount, 2, '显式开启的 rating 属性应生成稳定评分节点');
assert(!explicitCustomValues.nodes.some((node) => node.data.propertyId === 'confidence' && node.data.value === '0 星'), '未评分的 0 值应忽略');

const papersOnly = GraphModel.buildGraph(snapshot, { showAttributes: false });
assert.equal(papersOnly.stats.attributeCount, 0);
assert.equal(papersOnly.stats.propertyEdgeCount, 0);
assert(papersOnly.nodes.every((node) => node.data.type === 'paper'));

const identicalPapers = Array.from({ length: 6 }, (_, index) => ({ data: {
  id: `paper:${index}`,
  jobId: String(index),
  title: 'Shared multimodal model',
  abstract: 'vision language alignment',
  keywords: ['multimodal'],
  researchTopics: ['foundation model'],
} }));
const limited = GraphModel.computeSimilarityEdges(identicalPapers, { topK: 1, similarityThreshold: 0.05 });
const degrees = new Map();
for (const edge of limited.edges) {
  degrees.set(edge.data.source, (degrees.get(edge.data.source) || 0) + 1);
  degrees.set(edge.data.target, (degrees.get(edge.data.target) || 0) + 1);
}
assert(limited.edges.length > 0);
assert([...degrees.values()].every((degree) => degree <= 1), '每篇文献的相似边不得超过 topK');
assert.equal(limited.effectiveThreshold, 0.05);

const defaultLimited = GraphModel.computeSimilarityEdges(identicalPapers);
const defaultDegrees = new Map();
for (const edge of defaultLimited.edges) {
  defaultDegrees.set(edge.data.source, (defaultDegrees.get(edge.data.source) || 0) + 1);
  defaultDegrees.set(edge.data.target, (defaultDegrees.get(edge.data.target) || 0) + 1);
}
assert.equal(GraphModel.constants.DEFAULT_TOP_K, 2);
assert.equal(GraphModel.constants.DEFAULT_SIMILARITY_THRESHOLD, 0);
assert([...defaultDegrees.values()].every((degree) => degree <= 2), '默认每篇文献最多保留 2 条相似关系');

const permissiveThreshold = GraphModel.computeSimilarityEdges([
  { id: 'paper:left', title: 'vision language model', abstract: 'multimodal alignment' },
  { id: 'paper:right', title: 'vision protein model', abstract: 'structure alignment' },
], { similarityThreshold: 0, topK: 3 });
assert.equal(permissiveThreshold.effectiveThreshold, 0, '实际阈值应与用户选择一致');
assert(permissiveThreshold.edges.length > 0, '降低阈值应保留低分连接');

const highThreshold = GraphModel.computeSimilarityEdges([
  { id: 'paper:left', title: 'vision language model', abstract: 'multimodal alignment' },
  { id: 'paper:right', title: 'vision protein model', abstract: 'structure alignment' },
], { similarityThreshold: 0.99, topK: 3 });
assert.equal(highThreshold.edges.length, 0, '配置阈值应能排除低分连接');
assert.equal(highThreshold.effectiveThreshold, 0.99);
assert(permissiveThreshold.edges.length > highThreshold.edges.length, '降低阈值应能增加可见连接');

const longEnglishTitle = 'A Unified Framework for Multimodal Language Representation Learning Across Many Scientific Domains';
const longChineseTitle = '面向多模态科学文献理解与知识发现的统一大模型研究框架';
const normalizedVisuals = GraphView.normalizeGraph({ nodes: [
  { data: { id: 'paper:long-en', type: 'paper', label: longEnglishTitle, title: longEnglishTitle, importance: 5, size: 90 } },
  { data: { id: 'paper:long-zh', type: 'paper', label: longChineseTitle, title: longChineseTitle, importance: 0, size: 10 } },
  { data: { id: 'attribute:topic', type: 'attribute', label: '超长研究属性名称', size: 90 } },
] });
for (const paper of normalizedVisuals.nodes.filter((node) => node.data.type === 'paper')) {
  assert.equal(paper.data.label, paper.data.title, '画布省略不能修改完整标题');
  assert(paper.data.canvasLabel.split('\n').length <= 2, '画布标题最多显示两行');
  assert(paper.data.canvasLabel.endsWith('…'), '超长画布标题必须显示省略号');
  assert(paper.data.size >= 31 && paper.data.size <= 36, '视图层必须限制文献节点尺寸');
}
const normalizedAttribute = normalizedVisuals.nodes.find((node) => node.data.type === 'attribute').data;
const normalizedEnglish = normalizedVisuals.nodes.find((node) => node.data.id === 'paper:long-en').data;
assert(longEnglishTitle.startsWith(`${normalizedEnglish.canvasLabel.split('\n')[0]} `), '英文标题应优先在单词边界换行');
assert(normalizedAttribute.canvasLabel.split('\n').length === 1 && normalizedAttribute.canvasLabel.endsWith('…'), '长属性标题必须单行省略');
assert(normalizedAttribute.size >= 36 && normalizedAttribute.size <= 40, '视图层必须限制属性节点尺寸');
assert.equal(GraphView.normalizeViewportScale(), 0.85, '图谱视口缺省值应比适窗结果更紧凑');
assert.equal(GraphView.normalizeViewportScale(0.7), 0.7, '合法视口缩放值应保持不变');
assert.equal(GraphView.normalizeViewportScale(0.2), 0.6, '视口缩放值必须限制下界');
assert.equal(GraphView.normalizeViewportScale(2), 1.3, '视口缩放值必须限制上界');

const topicDragStrength = GraphView.magneticFollowerStrength({ propertyId: 'research_topic' });
const topicReleaseStrength = GraphView.magneticFollowerStrength({ propertyId: 'research_topic' }, 'release');
const venueDragStrength = GraphView.magneticFollowerStrength({ propertyId: 'venue' });
const venueReleaseStrength = GraphView.magneticFollowerStrength({ propertyId: 'venue' }, 'release');
assert(topicDragStrength > venueDragStrength, '研究主题应比普通属性具有更强的跟随吸附');
assert(topicReleaseStrength > topicDragStrength, '研究主题松手后应继续柔性收敛');
assert(venueReleaseStrength > venueDragStrength, '普通属性松手后应继续柔性收敛');
const magneticPosition = GraphView.magneticFollowerPosition({ x: 20, y: 30 }, { x: 100, y: -40 }, topicDragStrength);
assert(Math.abs(magneticPosition.x - 78) < 1e-9 && Math.abs(magneticPosition.y - 6.8) < 1e-9, '跟随位置应按锚点总位移计算，不能在每个拖动事件中重复累加');

const lowSimilarityStrength = GraphView.similarityFollowerStrength(0.05);
const highSimilarityStrength = GraphView.similarityFollowerStrength(0.8);
assert(highSimilarityStrength > lowSimilarityStrength, '高相似文献应比低相似文献具有更强的拖动牵引');
assert(GraphView.similarityFollowerStrength(0.8, 'release') > highSimilarityStrength, '文献松手后应继续柔性收敛');
const repelled = GraphView.localRepulsionTargets([
  { id: 'anchor', x: 100, y: 100, radius: 16 },
  { id: 'blocker', x: 124, y: 100, radius: 16 },
  { id: 'far', x: 500, y: 500, radius: 16 },
], { anchorId: 'anchor', activeIds: [], gap: 10 });
assert.equal(repelled.anchor.x, 100, '拖动锚点不能被局部排斥推离鼠标位置');
assert(repelled.blocker.x > 124, '附近节点应被锚点推开');
assert(!Object.prototype.hasOwnProperty.call(repelled, 'far'), '局部排斥不能移动影响半径外的节点');

const crowdedFollowers = Array.from({ length: 60 }, (_, index) => ({
  id: `follower:${index}`,
  x: 180 + (index % 10) * 45,
  y: 100 + Math.floor(index / 10) * 45,
  radius: 16,
}));
const crowdedFollowerIds = crowdedFollowers.map((node) => node.id);
const crowdedTargets = GraphView.localRepulsionTargets([
  { id: 'crowded-anchor', x: 100, y: 100, radius: 16 },
  ...crowdedFollowers,
  { id: 'passive:one', x: 124, y: 100, radius: 16 },
  { id: 'passive:two', x: 100, y: 124, radius: 16 },
  { id: 'passive:three', x: 126, y: 126, radius: 16 },
], { anchorId: 'crowded-anchor', activeIds: crowdedFollowerIds, maxNodes: 2 });
crowdedFollowerIds.forEach((id) => assert(Object.prototype.hasOwnProperty.call(crowdedTargets, id), `关联节点不能被被动排斥上限截断：${id}`));
assert(Object.keys(crowdedTargets).filter((id) => id.startsWith('passive:')).length <= 2, '局部力场只应限制被动排斥候选数量');

const collisionOrderingTargets = GraphView.localRepulsionTargets([
  { id: 'ordering-anchor', x: 100, y: 100, radius: 16 },
  { id: 'ordering-blocker', x: 124, y: 100, radius: 16 },
  ...Array.from({ length: 24 }, (_, index) => ({ id: `ordering-far:${index}`, x: 70, y: 70, radius: 1, locked: true })),
], { anchorId: 'ordering-anchor', activeIds: [], gap: 10 });
assert(collisionOrderingTargets['ordering-blocker'].x > 124, '碰撞比较上限不能因网格遍历顺序漏掉最近的重叠节点');

const lateNearestTargets = GraphView.localRepulsionTargets([
  { id: 'late-anchor', x: 0, y: 0, radius: 16 },
  { id: 'late-follower', x: 1000, y: 0, radius: 16 },
  ...Array.from({ length: 8 }, (_, index) => ({ id: `early-passive:${index}`, x: 80 + index, y: 20, radius: 1, locked: true })),
  { id: 'late-blocker', x: 1024, y: 0, radius: 16 },
], { anchorId: 'late-anchor', activeIds: ['late-follower'], gap: 10, maxNodes: 2 });
assert(lateNearestTargets['late-blocker']?.x > 1024, '候选池满后仍应接纳后续跟随节点附近更近的重叠节点');

const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'graph-model.js'), 'utf8');
const browserContext = { window: {} };
vm.runInNewContext(source, browserContext, { filename: 'graph-model.js' });
assert.equal(typeof browserContext.window.MyScholarGraphModel?.buildGraph, 'function', '浏览器 UMD 全局 API 缺失');

console.log(`graph_model_smoke: ok (${graph.stats.paperCount} papers, ${graph.stats.attributeCount} attributes, ${graph.stats.similarityEdgeCount} similarity edges)`);
