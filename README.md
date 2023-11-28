# Fiat ePer KTD file reader library for Node.js Apps

## Installation

### Install `tsktdreader`

```sh
$ npm install tsktdreader --save
```

## Usage

### Opening the database

```typescript
import KtdReader from 'tsktdreader'

const db1 = new KtdReader('SP.CH.03818.FCTLR')
db1.findByPrimaryKey('15000745586', 1)
db.findBySecondaryKey('VIN', 'ZFA31200000745586'.padEnd(25, ' '), 2)
```
