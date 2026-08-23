#!/usr/bin/env node
import { collectLocalInventory } from "../inventory.js";

process.stdout.write(`${JSON.stringify(await collectLocalInventory(), null, 2)}\n`);
