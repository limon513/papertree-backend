/**
 * The sections of the admin panel. A role lists which of these it can open.
 * Staff and roles management is not here on purpose: only Super Admins can do that.
 */
export const ADMIN_MODULES = [
  { key: 'products', label: 'Products', description: 'Products, categories, brands, stock' },
  { key: 'imports', label: 'Product Imports', description: 'Bulk import from files and websites' },
  { key: 'orders', label: 'Orders', description: 'Orders, payments, shipping' },
  { key: 'customers', label: 'Customers', description: 'Customers, business accounts, activity' },
  { key: 'marketing', label: 'Marketing', description: 'Campaigns, discounts, bulk pricing, coupons' },
  { key: 'content', label: 'Website Content', description: 'Banners, home page, menus, pages' },
  { key: 'leads', label: 'Requests & Leads', description: 'Quotations, custom orders, product requests, suppliers' },
  { key: 'reports', label: 'Reports', description: 'Sales and customer reports' },
  { key: 'settings', label: 'Settings', description: 'Delivery charges, payments, store settings' },
] as const;

export type AdminModule = (typeof ADMIN_MODULES)[number]['key'];

export const ADMIN_MODULE_KEYS = ADMIN_MODULES.map((m) => m.key) as [AdminModule, ...AdminModule[]];
