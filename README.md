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

const db = new JetDb('file.mdb')

for (const r of db.rows('TABLE')) {
  console.log(r.columns[0].value)
}

db.streamRows('TABLE').on('data', rows => {
  for (const r of rows) {
    console.log(r.columns[0].value)
  }
})
```
