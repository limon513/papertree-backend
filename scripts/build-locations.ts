/**
 * Writes src/data/bd-locations.json: Bangladesh divisions, districts and areas (upazilas, plus the
 * Dhaka City thanas, which are not upazilas). Used for delivery zones and, later, the checkout.
 *
 * Source: github.com/nuhil/bangladesh-geocode (MIT licence), pinned to one commit so the ids never move.
 * Run with: npm run locations:build
 */
import { mkdir, writeFile } from 'node:fs/promises';

const COMMIT = '5622f68bd07a98e076edcf8100bf0db6a75b9854';
const BASE = `https://raw.githubusercontent.com/nuhil/bangladesh-geocode/${COMMIT}`;

/** The dataset uses some old spellings; these are the official ones (2018 changes). */
const RENAMES: Record<string, string> = {
  Chattagram: 'Chattogram',
  Chittagong: 'Chattogram',
  Comilla: 'Cumilla',
  Barisal: 'Barishal',
  Bogra: 'Bogura',
  Jessore: 'Jashore',
  Coxsbazar: "Cox's Bazar",
};

/** Dhaka Metropolitan Police thanas: what people in Dhaka City write as their area. */
const DHAKA_CITY = [
  'Adabor', 'Badda', 'Banani', 'Bangshal', 'Bhashantek', 'Bhatara', 'Bimanbandar', 'Cantonment', 'Chawkbazar',
  'Dakshinkhan', 'Darus Salam', 'Demra', 'Dhanmondi', 'Gendaria', 'Gulshan', 'Hatirjheel', 'Hazaribagh', 'Jatrabari',
  'Kadamtali', 'Kafrul', 'Kalabagan', 'Kamrangirchar', 'Khilgaon', 'Khilkhet', 'Kotwali', 'Lalbagh', 'Mirpur',
  'Mohammadpur', 'Motijheel', 'Mugda', 'New Market', 'Pallabi', 'Paltan', 'Ramna', 'Rampura', 'Rupnagar', 'Sabujbagh',
  'Shah Ali', 'Shahbagh', 'Shahjahanpur', 'Sher-e-Bangla Nagar', 'Shyampur', 'Sutrapur', 'Tejgaon',
  'Tejgaon Industrial Area', 'Turag', 'Uttara East', 'Uttara West', 'Uttarkhan', 'Vatara', 'Wari',
];

const fix = (name: string) => RENAMES[name.trim()] ?? name.trim();
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function table<T>(name: string): Promise<T[]> {
  const res = await fetch(`${BASE}/${name}/${name}.json`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const parts = (await res.json()) as { type: string; data?: T[] }[];
  return parts.find((p) => p.type === 'table')!.data!;
}

const [divisions, districts, upazilas] = await Promise.all([
  table<{ id: string; name: string }>('divisions'),
  table<{ id: string; division_id: string; name: string }>('districts'),
  table<{ id: string; district_id: string; name: string }>('upazilas'),
]);

const dhaka = districts.find((d) => d.name === 'Dhaka');
if (!dhaka) throw new Error('Dhaka district not found');

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
const data = {
  source: `github.com/nuhil/bangladesh-geocode@${COMMIT.slice(0, 7)} (MIT), Dhaka City thanas added`,
  divisions: divisions.map((d) => ({ id: d.id, name: fix(d.name) })).sort(byName),
  districts: districts.map((d) => ({ id: d.id, name: fix(d.name), divisionId: d.division_id })).sort(byName),
  areas: [
    ...DHAKA_CITY.map((name) => ({ id: `dhaka-${slug(name)}`, name, districtId: dhaka.id, city: true })),
    ...upazilas.map((u) => ({ id: u.id, name: fix(u.name), districtId: u.district_id, city: false })),
  ].sort(byName),
};

await mkdir('src/data', { recursive: true });
await writeFile('src/data/bd-locations.json', `${JSON.stringify(data, null, 1)}\n`);
console.log(`${data.divisions.length} divisions, ${data.districts.length} districts, ${data.areas.length} areas`);
