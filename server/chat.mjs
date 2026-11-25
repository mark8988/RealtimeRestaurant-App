import { RequestError } from './menu.mjs';

function score(item, query) {
  if (query.includes(item.name)) return 1000 + item.name.length;
  const fragments = new Set();
  for (let i = 0; i < item.name.length - 1; i++) {
    const pair = item.name.slice(i, i + 2);
    if (pair !== item.category && query.includes(pair)) fragments.add(pair);
  }
  return fragments.size;
}

const allergies = [
  [/花生/, '花生'], [/芝麻/, '芝麻'], [/牛奶|乳製|奶/, '奶'], [/雞蛋|蛋/, '蛋'],
  [/黃豆|大豆|豆類/, '大豆'], [/麩質|小麥/, '小麥'], [/堅果/, '堅果'], [/海鮮/, '海鮮'], [/蝦/, '蝦']
];
const allergyNotice = '如有過敏，請先讓店員確認原料與交叉接觸風險。';

function normalizeAmounts(query) {
  const digits = '零一二三四五六七八九';
  return query.replace(/[零〇一二兩三四五六七八九十百千]+(?=元|塊|以內|以下|以上)/g, number => {
    const chars = [...number.replaceAll('兩', '二').replaceAll('〇', '零')];
    if (chars.every(c => digits.includes(c))) return chars.map(c => digits.indexOf(c)).join('');
    let total = 0, digit = 0;
    for (const c of chars) {
      if (digits.includes(c)) digit = digits.indexOf(c);
      else { total += (digit || 1) * ({ 十: 10, 百: 100, 千: 1000 })[c]; digit = 0; }
    }
    return String(total + digit);
  });
}

export function answer(items, body) {
  if (!body || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 500 ||
    !['host', 'chef'].includes(body.role) ||
    (body.previousItemId != null && typeof body.previousItemId !== 'string')) {
    throw new RequestError(400, '請選擇接待員或主廚，問題長度為 1 至 500 字。');
  }
  const query = normalizeAmounts(body.message.normalize('NFKC').replace(/\s/g, ''));
  const chef = body.role === 'chef';
  const priced = item => `${item.name}（${item.price} 元）`;
  const matched = items.map(item => ({ item, points: score(item, query) }))
    .filter(x => x.points > 0).sort((a,b) => b.points - a.points);
  const previous = items.find(item => item.id === body.previousItemId);
  const follow = /這道|那道|這個|那個|它|這款|那款|多少錢|有什麼材料|過敏原|怎麼做|會辣嗎|含.*嗎/.test(query);
  const focus = matched[0]?.item ?? (follow ? previous : null);
  const allergyQuestion = /過敏|能不能吃|不能吃|不能碰|不含|含有|含.*嗎|有沒有.*(奶|蛋|花生|芝麻|堅果|小麥|大豆)/.test(query);
  if (allergyQuestion) {
    if (focus) {
      const recorded = focus.allergens.length ? `已登錄的過敏原有${focus.allergens.join('、')}` : '目前沒有登錄過敏原';
      return { reply: `${focus.name}${recorded}。${allergyNotice}`, itemId: focus.id };
    }
    const concern = allergies.find(([pattern]) => pattern.test(query))?.[1];
    const known = concern && items.filter(item => item.allergens.some(a => a.includes(concern)));
    const caution = known?.length ? `菜單中${known.map(i => i.name).join('、')}標示含有${concern}。` : '';
    return { reply: caution + allergyNotice };
  }

  const veg = /全素|純素|vegan/i.test(query) ? ['全素'] :
    /素食|吃素|蛋奶素|素的/.test(query) ? ['蛋奶素','全素'] : [];
  const mild = /不辣|不要(?:太|那麼)?辣|不想吃(?:太)?辣|不吃辣|怕辣|別太辣|太辣不行/.test(query);
  const spicy = !mild && /辣/.test(query);
  const budget = query.match(/(?:預算|最多|不超過|不要超過|不想花超過|不能超過|低於)(?:是|為)?(?:NT\$|\$)?(\d+)/i)
    ?? query.match(/(\d+)(?:元|塊)?(?:以內|以下)/);
  const cap = budget ? Number(budget[1]) - (query.includes('低於') ? 1 : 0) : Infinity;
  const minimum = query.match(/(?:至少|高於)(\d+)/) ?? query.match(/(\d+)(?:元|塊)?以上/);
  const floor = minimum ? Number(minimum[1]) + (query.includes('高於') ? 1 : 0) : 0;
  const category = [...new Set(items.map(i => i.category))].find(c => query.includes(c));
  const tags = [...new Set(items.flatMap(item => item.tags))].filter(tag =>
    !['全素','蛋奶素','不辣','微辣'].includes(tag) && query.includes(tag));
  const cheapest = /便宜|省錢|低價/.test(query);
  const recommend = /推薦|建議|想吃|想喝|有什麼|有哪些|來一|換一|別的|其他/.test(query);
  const filters = Boolean(veg.length || mild || spicy || budget || minimum || tags.length || cheapest);
  if (focus && (!recommend || matched.length) && (!category || matched.length || follow)) {
    const parts = [`${priced(focus)}${focus.available ? '' : '目前暫停供應'}。`];
    if (!/多少錢|價格|幾元/.test(query)) {
      parts.push(focus.description);
      if (filters || /特色|口味|辣嗎|素嗎/.test(query)) {
        parts.push(focus.tags.length ? `菜單標示：${focus.tags.join('、')}。` : '菜單目前沒有登錄口味或飲食標籤。');
      }
    }
    return { reply: (chef ? '我是主廚。' : '') + parts.join(''), itemId: focus.id };
  }
  if (!recommend && !filters && !category && !/菜單|餐點|招牌|吃什麼/.test(query)) {
    return { reply: '想認識哪道餐點？可以說菜名，也可以告訴我預算或喜歡的口味。', semanticCandidates: items.filter(item => item.available).map(item => item.id) };
  }
  const options = items.filter(i => i.available && i.price <= cap && i.price >= floor &&
    (!veg.length || veg.some(tag => i.tags.includes(tag))) && (!mild || i.tags.includes('不辣')) &&
    (!spicy || i.tags.some(tag => tag.includes('辣') && tag !== '不辣')) &&
    (!category || category === i.category) && tags.every(t => i.tags.includes(t)) &&
    (!/換一|其他|別的/.test(query) || previous?.id !== i.id));
  if (cheapest) options.sort((a,b) => a.price - b.price);
  if (!options.length) return { reply: '目前供應的菜單裡，沒有找到符合這些條件的餐點。想看看其他分類或調整預算嗎？', semanticCandidates: [] };
  const [first, ...others] = options;
  const alt = others.slice(0, 2).map(priced).join('、');
  return { reply: `${chef ? '主廚推薦' : '您可以試試'}${priced(first)}。${first.description}${alt ? '其他選擇有' + alt + '。' : ''}`, itemId: first.id, ...(!cheapest && { semanticCandidates: options.map(item => item.id) }) };
}
