# Kenema Veteran Financial Management System

A simple, offline-friendly system to manage the finances of the Kenema Veterans association.

## Features
- **Admin login** — only the Admin can create or delete login accounts
- **Members** — register members, track status (Active / Inactive / Suspended / Deceased), monthly dues and contact info
- **Monthly Contributions** — record one payment per member per month (duplicate months are blocked), track who recorded each payment
- **Expenditures** — record expenses by category with dates
- **Dashboard** — collections vs expenditures for the last 6 months, outstanding amounts, members in arrears, membership status summary

## How to Run
1. Double-click **`Start System.bat`** (or run `node server.js` in this folder).
2. Open **http://localhost:3000** in your browser.

## First Login
| Username | Password |
|----------|----------|
| `admin`  | `admin@123` |

> ⚠️ Change this password immediately. Go to **User Accounts → create a new admin account**, log in as the new admin, and delete the default one.

## Roles
- **Admin** — everything: manage users, delete any record, manage members
- **Staff** — record contributions and expenditures, add/edit members (cannot delete records or manage users)

## Data Storage
All data is saved in `data/db.json` in this folder. Back this file up regularly (copy it to a flash drive). To reset the system, delete the `data` folder while the server is stopped.

## Tech
- Node.js (no external packages needed — nothing to install)
- JSON file storage
