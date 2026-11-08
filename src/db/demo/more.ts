/**
 * More of the sample shop: about 170 products across all categories, so lists have several pages,
 * filters have real choices, and the website can be tested with variety: options (colours, sizes,
 * packs), extra pictures, sales with end dates, low stock, sold out, very long names.
 * Everything is worked out from the product's place in the list (no randomness), so running the
 * demo again gives the same shop.
 */
import type { DemoBrand, DemoCategory, DemoProduct } from './data.ts';

/** New sub-categories, under existing main categories. */
export const MORE_CATEGORIES: { parent: string; category: DemoCategory }[] = [
  { parent: 'Writing', category: { name: 'Fountain Pens & Ink', icon: 'fountain-pen' } },
  { parent: 'Paper', category: { name: 'Sticky Notes & Notepads', icon: 'spiral-notepad' } },
  { parent: 'Art & Craft', category: { name: 'Brushes & Canvas', icon: 'paintbrush' } },
  { parent: 'Art & Craft', category: { name: 'Clay & Modelling', icon: 'teddy-bear' } },
  { parent: 'Office Supplies', category: { name: 'Desk Organisers', icon: 'inbox-tray' } },
  { parent: 'Office Supplies', category: { name: 'Tapes & Adhesives', icon: 'roll-of-paper' } },
  { parent: 'Office Supplies', category: { name: 'Envelopes', icon: 'envelope' } },
  { parent: 'School Supplies', category: { name: 'Pencil Cases', icon: 'pushpin' } },
  { parent: 'School Supplies', category: { name: 'Lunch Boxes & Bottles', icon: 'package' } },
];

export const MORE_BRANDS: DemoBrand[] = [
  { name: 'Linc', code: 'LN', color: '#0f766e', description: 'Everyday ball pens and gel pens, made for long writing.' },
  { name: 'Maped', code: 'MP', color: '#2563eb', featured: true, description: 'French school and office supplies: scissors, rulers, sharpeners.' },
  { name: 'Stabilo', code: 'SB', color: '#f97316', description: 'German highlighters, fineliners and colouring pencils.' },
  { name: 'Uni-ball', code: 'UB', color: '#be123c', description: 'Japanese roller and gel pens with smooth, fade-proof ink.' },
  { name: 'Pelikan', code: 'PK', color: '#1e40af', description: 'Fountain pens, inks and school colours since 1838.' },
  { name: 'Kokuyo', code: 'KK', color: '#334155', description: 'Japanese notebooks, files and desk supplies.' },
  { name: 'Classmate', code: 'CL', color: '#7c3aed', description: 'Notebooks and exercise books for students.' },
];

/** Icon per category (the picture shows it). */
const ICON: Record<string, string> = {
  Pens: 'pen',
  'Pencils & Erasers': 'pencil',
  'Markers & Highlighters': 'crayon',
  'Fountain Pens & Ink': 'black-nib',
  'Art Paper': 'framed-picture',
  'Printing & Copy Paper': 'printer',
  'Colour Paper': 'rainbow',
  'Sticky Notes & Notepads': 'spiral-notepad',
  'Exercise Books': 'notebook-with-decorative-cover',
  'Diaries & Planners': 'spiral-calendar',
  Sketchbooks: 'framed-picture',
  'Colours & Paints': 'artist-palette',
  'Craft Supplies': 'scissors',
  'Brushes & Canvas': 'paintbrush',
  'Clay & Modelling': 'teddy-bear',
  'Files & Folders': 'file-folder',
  'Staplers & Clips': 'linked-paperclips',
  Calculators: 'abacus',
  'Desk Organisers': 'inbox-tray',
  'Tapes & Adhesives': 'roll-of-paper',
  Envelopes: 'envelope',
  'Geometry & Rulers': 'triangular-ruler',
  'School Bags': 'backpack',
  'Pencil Cases': 'pushpin',
  'Lunch Boxes & Bottles': 'package',
  Gifts: 'wrapped-gift',
};

/** Colour choices per kind of product. */
const COLOURS: Record<string, string[]> = {
  pen: ['Blue', 'Black', 'Red'],
  marker: ['Black', 'Blue', 'Red', 'Green'],
  highlighter: ['Yellow', 'Green', 'Pink', 'Orange'],
  bag: ['Navy', 'Black', 'Maroon', 'Grey'],
  case: ['Blue', 'Pink', 'Green', 'Purple'],
  diary: ['Black', 'Brown', 'Navy'],
  file: ['Blue', 'Green', 'Red', 'Yellow'],
  bottle: ['Blue', 'Pink', 'Green'],
};

/**
 * [name, category, price (taka), flags]. Flags: c:<kind> colour options, z sizes (A5/A4),
 * r ruling (Ruled/Plain/Grid), k packs (Single / Pack of 5), m three more pictures.
 */
type Row = [string, string, number, string?];

const ROWS: Row[] = [
  // ---- Pens ----
  ['Linc Pentonic Ball Pen 0.7 mm', 'Pens', 15, 'c:pen m'],
  ['Linc Pentonic Ball Pen 0.7 mm (Pack of 10)', 'Pens', 140, 'c:pen'],
  ['Linc Glycer Ball Pen 0.6 mm', 'Pens', 12, 'c:pen k'],
  ['Linc Ocean Gel Pen 0.5 mm', 'Pens', 20, 'c:pen'],
  ['Uni-ball Eye Fine Roller Pen UB-157', 'Pens', 160, 'c:pen m'],
  ['Uni-ball Signo 207 Retractable Gel Pen 0.7 mm', 'Pens', 220, 'c:pen'],
  ['Uni-ball Jetstream SXN-150 Ball Pen 1.0 mm', 'Pens', 260, 'c:pen m'],
  ['Uni-ball Air Micro Rollerball Pen', 'Pens', 240, 'c:pen'],
  ['Pilot V5 Hi-Tecpoint Liquid Ink Pen 0.5 mm', 'Pens', 190, 'c:pen m'],
  ['Pilot BPS-GP Fine Ball Pen', 'Pens', 45, 'c:pen k'],
  ['Pilot Frixion Erasable Gel Pen 0.7 mm', 'Pens', 280, 'c:pen m'],
  ['Pentel R.S.V.P. Ball Pen Medium', 'Pens', 70, 'c:pen'],
  ['Pentel Energel Needle Tip 0.5 mm', 'Pens', 230, 'c:pen'],
  ['Matador Hi-School Ball Pen (Pack of 20)', 'Pens', 150, 'c:pen'],
  ['Matador Zero Gel Pen 0.5 mm', 'Pens', 25, 'c:pen k'],
  ['Matador Orange Ball Pen (Box of 50)', 'Pens', 300],
  ['Deli Q7 Quick-Dry Gel Pen 0.5 mm (Pack of 12)', 'Pens', 240, 'c:pen'],
  ['Deli Arrow Ball Pen 0.7 mm', 'Pens', 10, 'c:pen k'],
  ['Faber-Castell Trendz Ball Pen (Pack of 5)', 'Pens', 120],
  ['Faber-Castell Grip X5 Ball Pen', 'Pens', 40, 'c:pen'],
  ['Stabilo Point 88 Fineliner 0.4 mm', 'Pens', 90, 'c:marker m'],
  ['Stabilo Point 88 Fineliner Wallet of 20 Colours', 'Pens', 1650, 'm'],
  ['Staedtler Pigment Liner Set of 6 (0.05 to 0.8 mm)', 'Pens', 980, 'm'],
  ['Pilot Hi-Tecpoint V7 Cartridge System Pen', 'Pens', 260, 'c:pen'],
  ['Uni-ball Signo Broad UM-153 White Gel Pen for Dark Paper and Card Making', 'Pens', 210],
  // ---- Pencils & Erasers ----
  ['Doms Zoom Ultimate Dark Pencil (Pack of 10)', 'Pencils & Erasers', 70, 'm'],
  ['Doms Neon Pencil with Eraser Tip (Pack of 10)', 'Pencils & Erasers', 75],
  ['Doms Pencil Kit Box with Sharpener, Eraser and Scale', 'Pencils & Erasers', 120, 'm'],
  ['Staedtler Mars Lumograph Drawing Pencil Set of 12', 'Pencils & Erasers', 1250, 'm'],
  ['Staedtler Tradition 2B Pencil (Pack of 12)', 'Pencils & Erasers', 360],
  ['Faber-Castell Pitt Graphite Pencil Set of 6', 'Pencils & Erasers', 690],
  ['Faber-Castell Extra-Fine Erasers (Pack of 20)', 'Pencils & Erasers', 200],
  ['Faber-Castell Tri-Click Mechanical Pencil 0.7 mm', 'Pencils & Erasers', 95, 'c:case'],
  ['Pentel Hi-Polymer Eraser Large', 'Pencils & Erasers', 60, 'k'],
  ['Pentel Graphgear 500 Drafting Pencil 0.5 mm', 'Pencils & Erasers', 650, 'm'],
  ['Pentel Hi-Polymer Leads 0.5 mm HB (Tube of 12)', 'Pencils & Erasers', 80, 'k'],
  ['Maped Black Peps HB Pencil (Pack of 12)', 'Pencils & Erasers', 250],
  ['Maped Tonic Double Hole Sharpener with Container', 'Pencils & Erasers', 120, 'c:case'],
  ['Maped Technic 600 Eraser', 'Pencils & Erasers', 35, 'k'],
  ['Deli Electric Pencil Sharpener (Battery)', 'Pencils & Erasers', 790, 'm'],
  ['Natraj 621 HB Pencil (Pack of 10)', 'Pencils & Erasers', 60],
  // ---- Markers & Highlighters ----
  ['Stabilo Boss Original Highlighter', 'Markers & Highlighters', 110, 'c:highlighter m'],
  ['Stabilo Boss Original Pastel Highlighter Set of 6', 'Markers & Highlighters', 720, 'm'],
  ['Stabilo Swing Cool Pocket Highlighter', 'Markers & Highlighters', 95, 'c:highlighter'],
  ['Faber-Castell Textliner 46 Highlighter Set of 5', 'Markers & Highlighters', 380],
  ['Deli Permanent Marker Twin Tip', 'Markers & Highlighters', 45, 'c:marker k'],
  ['Deli Whiteboard Marker Set of 4 with Eraser', 'Markers & Highlighters', 260],
  ['Camlin Kokuyo Whiteboard Marker Refill Ink 15 ml', 'Markers & Highlighters', 55, 'c:marker'],
  ['Pilot Super Color Permanent Marker', 'Markers & Highlighters', 85, 'c:marker'],
  ['Uni Posca PC-5M Paint Marker', 'Markers & Highlighters', 320, 'c:marker m'],
  ['Pentel Sign Pen S520', 'Markers & Highlighters', 75, 'c:marker'],
  ['Matador Glitter Marker Set of 10', 'Markers & Highlighters', 260],
  ['Staedtler Lumocolor Permanent Marker Set of 8', 'Markers & Highlighters', 990],
  // ---- Fountain Pens & Ink ----
  ['Pelikan Pelikano Junior Fountain Pen for Beginners', 'Fountain Pens & Ink', 1450, 'c:case m'],
  ['Pelikan Twist Fountain Pen Medium Nib', 'Fountain Pens & Ink', 1250, 'c:case m'],
  ['Pelikan 4001 Ink Bottle 30 ml', 'Fountain Pens & Ink', 450, 'c:pen'],
  ['Pelikan Ink Cartridges 4001 (Pack of 6)', 'Fountain Pens & Ink', 180, 'c:pen k'],
  ['Pilot Kakuno Fountain Pen Fine Nib', 'Fountain Pens & Ink', 1150, 'c:case m'],
  ['Pilot Iroshizuku Fountain Pen Ink 15 ml', 'Fountain Pens & Ink', 1350],
  ['Faber-Castell School Fountain Pen with Ink Eraser', 'Fountain Pens & Ink', 520],
  ['Deli Calligraphy Pen Set with 3 Nibs', 'Fountain Pens & Ink', 690],
  ['Camlin Fountain Pen Ink 60 ml', 'Fountain Pens & Ink', 90, 'c:pen'],
  // ---- Paper ----
  ['Double A Premium A4 Paper 70 GSM (500 Sheets)', 'Printing & Copy Paper', 690],
  ['Double A Premium A4 Paper 80 GSM (5 Reams)', 'Printing & Copy Paper', 3550],
  ['Bashundhara Offset Paper A4 80 GSM (500 Sheets)', 'Printing & Copy Paper', 640],
  ['Legal Size Copy Paper 80 GSM (500 Sheets)', 'Printing & Copy Paper', 820],
  ['Photo Paper 4R Glossy 180 GSM (100 Sheets)', 'Printing & Copy Paper', 520],
  ['Canson XL Mixed Media Pad A4 (30 Sheets)', 'Art Paper', 890, 'm'],
  ['Canson Montval Watercolour Block 300 GSM A5', 'Art Paper', 1350],
  ['Handmade Paper Sheets Natural (10 Sheets)', 'Art Paper', 350],
  ['Black Drawing Paper A3 (20 Sheets)', 'Art Paper', 300],
  ['Tracing Paper Pad A4 (40 Sheets)', 'Art Paper', 240],
  ['Origami Paper 15 cm Double Coloured (100 Sheets)', 'Colour Paper', 220, 'm'],
  ['Pastel Colour Card Paper A4 (50 Sheets)', 'Colour Paper', 280],
  ['Glitter Foam Sheets A4 (10 Colours)', 'Colour Paper', 260],
  ['Fluorescent Paper A4 (5 Colours, 100 Sheets)', 'Colour Paper', 390],
  ['Deli Sticky Notes 3 × 3 Inch (100 Sheets)', 'Sticky Notes & Notepads', 60, 'c:highlighter k'],
  ['Deli Neon Page Markers (5 Colours)', 'Sticky Notes & Notepads', 90, 'k'],
  ['Kokuyo Campus Sticky Notes Lined 4 × 6 Inch', 'Sticky Notes & Notepads', 180],
  ['Spiral Pocket Notepad (Pack of 3)', 'Sticky Notes & Notepads', 90],
  ['Legal Pad Yellow A4 (50 Sheets)', 'Sticky Notes & Notepads', 140, 'k'],
  ['Shopping List Magnetic Notepad', 'Sticky Notes & Notepads', 160],
  // ---- Notebooks & Diaries ----
  ['Classmate Notebook 172 Pages Single Line', 'Exercise Books', 75, 'z m'],
  ['Classmate Pulse Spiral Notebook 300 Pages', 'Exercise Books', 220, 'r'],
  ['Classmate Long Book 140 Pages (Pack of 6)', 'Exercise Books', 420],
  ['Classmate Drawing Book Unruled 36 Pages', 'Exercise Books', 55, 'k'],
  ['Kokuyo Campus Notebook B5 (Pack of 5)', 'Exercise Books', 650, 'r m'],
  ['Kokuyo Campus Loose Leaf Paper B5 (100 Sheets)', 'Exercise Books', 280, 'r'],
  ['Fresh Exercise Book 80 Pages (Pack of 12)', 'Exercise Books', 360],
  ['Bengali Handwriting Practice Book Class 1', 'Exercise Books', 70],
  ['English Cursive Writing Copy (Set of 4)', 'Exercise Books', 160],
  ['Mathematics Graph Book 50 Pages', 'Exercise Books', 50, 'k'],
  ['Deli Hardcover Business Notebook A5 with Elastic Band', 'Diaries & Planners', 450, 'c:diary m'],
  ['Undated Daily Planner A5 365 Pages', 'Diaries & Planners', 590, 'c:diary'],
  ['Desk Calendar 2027 with Notes Space', 'Diaries & Planners', 280],
  ['Leather Journal with Handmade Pages A6', 'Diaries & Planners', 850, 'c:diary m'],
  ['Student Homework Planner 2027', 'Diaries & Planners', 220],
  ['Faber-Castell Sketch Pad A4 (50 Sheets)', 'Sketchbooks', 380, 'z'],
  ['Pocket Sketchbook A6 Hard Cover', 'Sketchbooks', 260],
  ['Kraft Paper Sketchbook Spiral 100 GSM', 'Sketchbooks', 320, 'z'],
  // ---- Art & Craft ----
  ['Faber-Castell Connector Pens 50 Shades', 'Colours & Paints', 1350, 'm'],
  ['Faber-Castell Watercolour Cakes 24 Shades with Brush', 'Colours & Paints', 650, 'm'],
  ['Faber-Castell Classic Colour Pencils 36 Shades', 'Colours & Paints', 990],
  ['Stabilo Trio Thick Colour Pencils 12 Shades', 'Colours & Paints', 560],
  ['Doms Wax Crayons 24 Shades', 'Colours & Paints', 110, 'm'],
  ['Doms Oil Pastels 50 Shades', 'Colours & Paints', 260],
  ['Camlin Student Water Colour Tubes 12 Shades', 'Colours & Paints', 220],
  ['Camlin Fabric Colours 10 Shades', 'Colours & Paints', 450],
  ['Pelikan Opaque Watercolour Paint Box 24 Colours', 'Colours & Paints', 1950, 'm'],
  ['Maped Color Peps Felt Pens 24 Colours', 'Colours & Paints', 480],
  ['Acrylic Paint Set 24 Colours × 12 ml', 'Colours & Paints', 590],
  ['Gouache Paint Set 18 Colours × 12 ml', 'Colours & Paints', 650],
  ['Kids Finger Paint Set 6 Colours (Washable, Non-Toxic)', 'Colours & Paints', 390],
  ['Round Paint Brushes Set of 10 (Nylon)', 'Brushes & Canvas', 290, 'm'],
  ['Flat Paint Brushes Set of 6 (Hog Hair)', 'Brushes & Canvas', 340],
  ['Water Brush Pens Set of 3', 'Brushes & Canvas', 250],
  ['Stretched Canvas Board 30 × 40 cm', 'Brushes & Canvas', 290, 'k'],
  ['Canvas Panel Pack 20 × 25 cm (Pack of 6)', 'Brushes & Canvas', 650],
  ['Wooden Table Easel for Painting', 'Brushes & Canvas', 890, 'm'],
  ['Plastic Palette with 18 Wells', 'Brushes & Canvas', 120],
  ['Play Dough 8 Colours with Moulds', 'Clay & Modelling', 450, 'm'],
  ['Air Dry Clay White 500 g', 'Clay & Modelling', 380],
  ['Polymer Clay 24 Colours with Tools', 'Clay & Modelling', 990, 'm'],
  ['Modelling Tools Set (11 Pieces)', 'Clay & Modelling', 260],
  ['Deli Craft Scissors Zigzag Edges (Pack of 5)', 'Craft Supplies', 320],
  ['Hot Glue Gun with 10 Glue Sticks', 'Craft Supplies', 550, 'm'],
  ['Googly Eyes Self-Adhesive (500 Pieces)', 'Craft Supplies', 150],
  ['Pom Poms Assorted Colours (300 Pieces)', 'Craft Supplies', 180],
  ['Pipe Cleaners Chenille Stems (100 Pieces)', 'Craft Supplies', 160],
  ['Ice Cream Sticks Coloured (100 Pieces)', 'Craft Supplies', 120],
  ['Washi Tape Set 10 Rolls Floral', 'Craft Supplies', 290],
  // ---- Office Supplies ----
  ['Kokuyo Clear Holder A4 40 Pockets', 'Files & Folders', 260, 'c:file'],
  ['Deli Expanding File 13 Pockets A4', 'Files & Folders', 390, 'c:file m'],
  ['Deli Ring Binder 2D A4 40 mm', 'Files & Folders', 180, 'c:file'],
  ['Paper Folder with Clip (Pack of 10)', 'Files & Folders', 150],
  ['Document Bag with Zip A4 (Pack of 5)', 'Files & Folders', 220, 'c:file'],
  ['Kokuyo Report Cover Clip File A4', 'Files & Folders', 120, 'k'],
  ['Deli Heavy Duty Stapler 100 Sheets', 'Staplers & Clips', 1450, 'm'],
  ['Deli Mini Stapler No. 10 with Pins', 'Staplers & Clips', 140, 'c:case'],
  ['Kangaro Stapler Pins 24/6 (Box of 1000)', 'Staplers & Clips', 60, 'k'],
  ['Deli Paper Clips 28 mm (Box of 100)', 'Staplers & Clips', 45, 'k'],
  ['Deli 2-Hole Paper Punch', 'Staplers & Clips', 290],
  ['Push Pins Assorted Colours (Box of 100)', 'Staplers & Clips', 80],
  ['Casio MJ-12D Desktop Calculator', 'Calculators', 1250, 'm'],
  ['Casio fx-991ES Plus Scientific Calculator', 'Calculators', 2450, 'm'],
  ['Casio fx-82MS Scientific Calculator', 'Calculators', 1550],
  ['Deli Pocket Calculator 8 Digits', 'Calculators', 290, 'c:case'],
  ['Deli Mesh Desk Organiser 5 Compartments', 'Desk Organisers', 650, 'm'],
  ['Deli Pen Holder Mesh Round', 'Desk Organisers', 180],
  ['Magazine File Holder (Pack of 2)', 'Desk Organisers', 420],
  ['Document Tray 3 Tier', 'Desk Organisers', 890],
  ['Desk Drawer Organiser with 4 Drawers', 'Desk Organisers', 1150, 'm'],
  ['Deli Clear Tape 18 mm × 30 m (Pack of 6)', 'Tapes & Adhesives', 210, 'k'],
  ['Deli Packing Tape Brown 48 mm × 100 m', 'Tapes & Adhesives', 160, 'k'],
  ['Double-Sided Foam Tape 24 mm', 'Tapes & Adhesives', 120],
  ['Masking Tape 24 mm (Pack of 3)', 'Tapes & Adhesives', 150],
  ['Deli Tape Dispenser Heavy', 'Tapes & Adhesives', 390],
  ['Fevicol MR White Glue 100 g', 'Tapes & Adhesives', 95, 'k'],
  ['Super Glue Instant Adhesive 3 g (Pack of 3)', 'Tapes & Adhesives', 90],
  ['White Envelopes 9 × 4 Inch (Pack of 50)', 'Envelopes', 180],
  ['Brown Envelopes A4 (Pack of 25)', 'Envelopes', 250],
  ['Bubble Mailers 6 × 9 Inch (Pack of 10)', 'Envelopes', 320],
  ['Greeting Card Envelopes Coloured (Pack of 20)', 'Envelopes', 160],
  // ---- School Supplies ----
  ['Maped Study Geometry Set 10 Pieces', 'Geometry & Rulers', 390, 'm'],
  ['Maped Flexible Ruler 30 cm', 'Geometry & Rulers', 90, 'c:case'],
  ['Maped Compass Stop System with Pencil', 'Geometry & Rulers', 450],
  ['Camlin Scholar Mathematical Drawing Instruments', 'Geometry & Rulers', 280],
  ['Aluminium Scale 60 cm', 'Geometry & Rulers', 260],
  ['Protractor 180 Degree (Pack of 5)', 'Geometry & Rulers', 75],
  ['Kids School Backpack with Rain Cover', 'School Bags', 1450, 'c:bag m'],
  ['Laptop Backpack 15.6 Inch Water Resistant', 'School Bags', 2450, 'c:bag m'],
  ['Trolley School Bag with Wheels', 'School Bags', 3250, 'c:bag'],
  ['Drawstring Gym Bag', 'School Bags', 390, 'c:bag'],
  ['Maped Zip Pencil Pouch 2 Compartments', 'Pencil Cases', 390, 'c:case m'],
  ['Silicone Pencil Case Cute Animals', 'Pencil Cases', 290, 'c:case'],
  ['Multi-Layer Pencil Box with Sharpener', 'Pencil Cases', 450, 'c:case m'],
  ['Transparent Exam Pencil Case', 'Pencil Cases', 120, 'k'],
  ['Stainless Steel Lunch Box 3 Compartments', 'Lunch Boxes & Bottles', 790, 'm'],
  ['Kids Lunch Box with Spoon and Fork', 'Lunch Boxes & Bottles', 450, 'c:bottle'],
  ['Water Bottle 750 ml BPA-Free', 'Lunch Boxes & Bottles', 390, 'c:bottle m'],
  ['Insulated Steel Bottle 500 ml Hot and Cold', 'Lunch Boxes & Bottles', 950, 'c:bottle'],
  // ---- Gifts ----
  ['Parker Vector Standard Fountain Pen Gift Box', 'Gifts', 1950, 'm'],
  ['Staedtler Design Journey Drawing Gift Tin 25 Pieces', 'Gifts', 2650, 'm'],
  ['Faber-Castell Young Artist Gift Box 63 Pieces', 'Gifts', 2950, 'm'],
  ['Student Stationery Kit 12 Pieces', 'Gifts', 650],
  ['Executive Pen and Notebook Gift Set', 'Gifts', 1250],
  ['Doms Art Strokes Kit for Young Artists', 'Gifts', 890],
];

/** A small, repeatable number from 0 to 1 for product `i` (the same every run). */
const det = (i: number, salt: number) => {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};
const to5 = (n: number) => Math.max(5, Math.round(n / 5) * 5);

const p = (text: string) => `<p>${text}</p>`;
const ul = (...items: string[]) => `<ul>${items.map((i) => `<li><p>${i}</p></li>`).join('')}</ul>`;

const SHORT: Record<string, string> = {
  Pens: 'Smooth, steady ink for notes, exams and everyday writing.',
  'Pencils & Erasers': 'Clean lines and easy erasing for school, office and drawing.',
  'Markers & Highlighters': 'Bright, quick-drying colour that stands out.',
  'Fountain Pens & Ink': 'For handwriting practice and beautiful letters.',
  'Art Paper': 'Takes pencil, ink and colour without bleeding through.',
  'Printing & Copy Paper': 'Jam-free paper for printers and photocopiers.',
  'Colour Paper': 'Bright sheets for crafts, decoration and school projects.',
  'Sticky Notes & Notepads': 'Quick notes, reminders and page markers.',
  'Exercise Books': 'Good paper that does not let ink bleed through.',
  'Diaries & Planners': 'Plan your days, keep your notes in one place.',
  Sketchbooks: 'Heavy paper for sketching and drawing practice.',
  'Colours & Paints': 'Rich, bright colours for school and art projects.',
  'Craft Supplies': 'Everything for school crafts and handmade gifts.',
  'Brushes & Canvas': 'Tools for painting at home, school or studio.',
  'Clay & Modelling': 'Soft, safe modelling fun for children and artists.',
  'Files & Folders': 'Keep papers flat, safe and easy to find.',
  'Staplers & Clips': 'Strong and reliable for daily office use.',
  Calculators: 'Clear display and long battery life.',
  'Desk Organisers': 'A tidy desk with everything in reach.',
  'Tapes & Adhesives': 'Sticks well, for packing, office and crafts.',
  Envelopes: 'Sturdy envelopes for letters, documents and parcels.',
  'Geometry & Rulers': 'Accurate tools for maths and drawing.',
  'School Bags': 'Comfortable straps and room for books and a water bottle.',
  'Pencil Cases': 'Keeps pens and pencils together in the school bag.',
  'Lunch Boxes & Bottles': 'Food-safe and easy to clean, for school and office.',
  Gifts: 'A ready-to-give present for students, artists and professionals.',
};

/** Extra info the seed uses: more pictures and pictures per colour. */
export interface MoreProduct extends DemoProduct {
  /** Three more pictures in the gallery. */
  morePictures?: boolean;
  /** Each colour option has its own picture. */
  colourPictures?: boolean;
  /** The sale ends this many days from now. */
  saleDays?: number;
}

export function moreProducts(brandNames: string[]): MoreProduct[] {
  return ROWS.map(([name, category, price, flags = ''], i) => {
    const has = (f: string) => flags.split(' ').some((x) => x === f || x.startsWith(`${f}:`));
    const colourKind = flags.split(' ').find((x) => x.startsWith('c:'))?.slice(2);
    const brand = brandNames.find((b) => name.toLowerCase().startsWith(b.toLowerCase()));

    const options: { name: string; values: string[] }[] = [];
    const variantPrices: Record<string, number> = {};
    if (colourKind) options.push({ name: 'Colour', values: COLOURS[colourKind]! });
    if (has('z')) options.push({ name: 'Size', values: ['A5', 'A4'] });
    if (has('r')) options.push({ name: 'Ruling', values: ['Ruled', 'Plain', 'Grid'] });
    if (has('k')) options.push({ name: 'Pack', values: ['Single', 'Pack of 5'] });
    // Bigger sizes and packs cost more.
    const labels = options.reduce<string[][]>((acc, o) => acc.flatMap((c) => o.values.map((v) => [...c, v])), [[]]);
    for (const values of labels) {
      let factor = 1;
      if (values.includes('A4')) factor *= 1.6;
      if (values.includes('Pack of 5')) factor *= 4.5;
      if (factor !== 1) variantPrices[values.join(' / ')] = to5(price * factor);
    }

    // Repeatable variety: ~25% on sale (some ending soon), ~10% low stock, ~6% sold out.
    const r = det(i, 1);
    const onSale = det(i, 2) < 0.25;
    const variants = Math.max(1, labels.length);
    const stock = Array.from({ length: variants }, (_, v) => {
      const s = det(i * 7 + v, 3);
      if (r < 0.06) return 0;
      if (r < 0.16) return 1 + Math.floor(s * 4);
      return 10 + Math.floor(s * 240);
    });

    const short = SHORT[category] ?? 'Quality stationery at a fair price.';
    return {
      name,
      category,
      brand,
      icon: ICON[category] ?? 'sparkles',
      price,
      sale: onSale ? to5(price * (0.8 + det(i, 4) * 0.12)) : undefined,
      saleDays: onSale && det(i, 5) < 0.4 ? 3 + Math.floor(det(i, 6) * 25) : undefined,
      wholesale: to5(price * 0.85),
      cost: to5(price * 0.7),
      stock,
      lowStock: 5,
      short,
      description:
        p(`${name}. ${short}`) +
        ul(
          brand ? `Original ${brand} product.` : 'Good quality at an everyday price.',
          options.length ? `Choose ${options.map((o) => o.name.toLowerCase()).join(' and ')}.` : 'Ready to use.',
          'Cash on delivery all over Bangladesh.',
        ),
      tags: [category.toLowerCase(), ...(brand ? [brand.toLowerCase()] : [])],
      specs: [
        ['Category', category],
        ...(brand ? ([['Brand', brand]] as [string, string][]) : []),
      ],
      options,
      variantPrices,
      weight: Math.max(20, Math.round(price / 4)),
      morePictures: has('m'),
      colourPictures: !!colourKind && has('m'),
    };
  });
}
