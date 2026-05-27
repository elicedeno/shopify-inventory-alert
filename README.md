markdown# 🚨 Shopify Inventory Alert System

Automated inventory monitoring for Shopify stores. Get instant email alerts when products go out of stock or fall below custom thresholds.

## 🎥 Demo

Watch the system in action: [YouTube Demo](https://youtu.be/LkwZPfsm-KE)

## 💡 The Problem

Shopify store owners lose sales every time a product silently goes out of stock. Manually checking inventory is time-consuming and easy to miss. This automation handles it 24/7.

## ⚡ Features

- 📅 Scheduled daily inventory checks via cron
- 🔌 Direct Shopify Admin API integration (GraphQL, 2025-07)
- 📧 Instant email alerts for out-of-stock items
- 📊 Daily summary reports with full breakdown
- 🎛️ Configurable low-stock threshold
- 🛡️ Built-in error handling and failure notifications
- 🔒 Secure credential management via .env

## 🛠️ Tech Stack

- **Runtime:** Node.js v24+
- **API:** Shopify Admin API (GraphQL)
- **Email:** Nodemailer (Gmail SMTP)
- **Scheduling:** node-cron
- **Config:** dotenv

## 🚀 Setup

1. Clone the repo
2. Run `npm install`
3. Copy `.env.example` to `.env` and fill in your credentials
4. Run `node index.js --test` to test the system
5. Run `node index.js` to start the scheduled service

## 📬 Need a custom build?

Available for hire — I build custom inventory and email automations for Shopify stores.

📧 **Email:** eliedeno528@gmail.com

Built by Eli Cedeno
