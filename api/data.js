export default async function handler(req, res) {
  const TOKEN = process.env.AIRTABLE_TOKEN;
  if (!TOKEN) return res.status(500).json({ error: 'AIRTABLE_TOKEN not configured' });

  const BASE_URL = 'https://api.airtable.com/v0/appVAtkYf5jZJBNt6';
  const HEADERS = { Authorization: `Bearer ${TOKEN}` };
  const BK_ALIASES = ['belkins', 'belkins.io lead', 'belkins no show'];

  async function airtableFetch(tableId, params) {
    const records = [];
    let offset;
    do {
      const qs = new URLSearchParams(params.toString());
      if (offset) qs.set('offset', offset);
      const r = await fetch(`${BASE_URL}/${tableId}?${qs}`, { headers: HEADERS });
      if (!r.ok) throw new Error(`Airtable ${r.status}: ${await r.text()}`);
      const json = await r.json();
      records.push(...(json.records || []));
      offset = json.offset;
    } while (offset);
    return records;
  }

  try {
    // --- Brands ---
    const brandParams = new URLSearchParams({ filterByFormula: '{fldCaUzDXtZI0KNtD}>4', returnFieldsByFieldId: 'true' });
    [
      'fldshFXjqXByq1s9M', // name
      'fldCaUzDXtZI0KNtD', // m30
      'fldVzzdDOJPpBOKiJ', // p30  (panel 3 table)
      'fldNEbE4UJI23fTXf', // rp30 (rate-specific proposals 30d)
      'fldDIYGSKi8nC7Pmz', // m60
      'fldhDCNf4BDUPJzCE', // p60  (panel 3 table)
      'fldqLIicpbKG0en8M', // rp60 (rate-specific proposals 60d)
      'fldoB114soMUt2fo6', // close60
      'fldXssZcxPaFMHg3Q', // cpc
      'fldG7jYf1BSVoHohy', // m10
      'fld4pNyquCZi0hpV9', // p10
    ].forEach(f => brandParams.append('fields[]', f));

    const brandRecs = await airtableFetch('tblsHf1pjuxiHpyg0', brandParams);

    const brands = brandRecs.map(r => {
      const f = r.fields;
      const name = String(f['fldshFXjqXByq1s9M'] ?? '');
      return {
        name,
        m30:     Number(f['fldCaUzDXtZI0KNtD'] ?? 0),
        p30:     Number(f['fldVzzdDOJPpBOKiJ'] ?? 0),
        m60:     Number(f['fldDIYGSKi8nC7Pmz'] ?? 0),
        p60:     Number(f['fldhDCNf4BDUPJzCE'] ?? 0),
        close60: Number(f['fldoB114soMUt2fo6'] ?? 0),
        cpc:     Number(f['fldXssZcxPaFMHg3Q'] ?? 0),
        m10:     Number(f['fldG7jYf1BSVoHohy'] ?? 0),
        p10:     Number(f['fld4pNyquCZi0hpV9'] ?? 0),
        rp30:    Number(f['fldNEbE4UJI23fTXf'] ?? 0),
        rp60:    Number(f['fldqLIicpbKG0en8M'] ?? 0),
        isBk:    /belkins/i.test(name),
        isOC:    !/belkins|inbound|reengage/i.test(name),
      };
    });

    // --- Belkins upcoming meetings (next 7 days) ---
    const todayStr = new Date().toISOString().split('T')[0];
    const meetFields = 'fields[]=fld7zZzMwap8H0mUC&fields[]=fldkuIMYiI1ZDVnfJ&returnFieldsByFieldId=true';
    const meetFormula = encodeURIComponent(
      `AND({fld7zZzMwap8H0mUC}="Belkins", IS_AFTER({fldkuIMYiI1ZDVnfJ}, TODAY()))`
    );
    const meetUrl = `${BASE_URL}/tblf9yaWmUjZ7Ggj5?${meetFields}&filterByFormula=${meetFormula}&pageSize=100&sort[0][field]=fldkuIMYiI1ZDVnfJ&sort[0][direction]=asc`;

    const meetResp = await fetch(meetUrl, { headers: HEADERS });
    if (!meetResp.ok) throw new Error(`Airtable meetings ${meetResp.status}: ${await meetResp.text()}`);
    const meetJson = await meetResp.json();
    const meetRecs = meetJson.records || [];

    // Build next-7-days bucket map (UTC dates)
    const today = new Date();
    const dateMap = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() + i);
      dateMap[`${d.getUTCMonth() + 1}/${d.getUTCDate()}`] = 0;
    }
    for (const r of meetRecs) {
      const raw = r.fields['fldkuIMYiI1ZDVnfJ'];
      if (!raw) continue;
      const d = new Date(raw);
      const key = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
      if (key in dateMap) dateMap[key]++;
    }
    const bkFuture = Object.entries(dateMap).map(([date, count]) => ({ date, count }));

    // --- Rates (from pre-computed Airtable fields) ---
    const r = (p, m) => m ? Math.round((p / m) * 100) : 0;
    const ocB    = brands.filter(b => b.isOC);
    const bkB    = brands.filter(b => b.name === 'Belkins');
    const s      = (arr, k) => arr.reduce((acc, b) => acc + b[k], 0);

    const ocM30  = s(ocB, 'm30');  const ocRP30 = s(ocB, 'rp30');
    const ocM60  = s(ocB, 'm60');  const ocRP60 = s(ocB, 'rp60');
    const bkM30  = s(bkB, 'm30');  const bkRP30 = s(bkB, 'rp30');
    const bkM60  = s(bkB, 'm60');  const bkRP60 = s(bkB, 'rp60');

    const rates = {
      oc:      { r30: r(ocRP30, ocM30),          r60: r(ocRP60, ocM60) },
      belkins: { r30: r(bkRP30, bkM30),          r60: r(bkRP60, bkM60) },
      blended: { r30: r(ocRP30 + bkRP30, ocM30 + bkM30), r60: r(ocRP60 + bkRP60, ocM60 + bkM60) },
    };

    res.setHeader('Cache-Control', 's-maxage=300');
    return res.status(200).json({ brands, bkFuture, rates });

  } catch (err) {
    console.error('[data]', err);
    return res.status(500).json({ error: err.message });
  }
}
