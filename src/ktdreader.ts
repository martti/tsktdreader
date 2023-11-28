import { Parser } from 'binary-parser'
import * as fs from 'fs'
import Bunzip from 'seek-bzip'

type Config = {
  version: number
  records: number
  blockSize: number
  referencePositions: number[]
  primaryKeyPosition: number
  secondaryKeyPositions: number[]
  tableName: string
  primaryKeyItemCount: number
  primaryKeyItems: Field[]
  secondaryKeyItemCount: number
  secondaryKeyItems: SecondaryKeyItem[]
  columnItemsCount: number
  columnItems: Field[]
  primaryKeyLength: number
  secondaryKeyLengths: number[]
  referenceTables: number[][][]
  referencePadding: number
  referenceIndex: number[]
  columnPackedPositions: number[]
}

type SecondaryKeyItem = {
  count: number
  items: Field[]
}

type Field = {
  name: string
  dataType: number
  startPosition: number
  length: number
}

export class KtdReader {
  #fh: number
  private filename: string
  public config: Config;

  [Symbol.dispose]() {
    fs.closeSync(this.#fh)
  }

  constructor(filename: string) {
    this.filename = filename
    this.#fh = fs.openSync(this.filename, 'r')
    this.config = this.init()
  }

  public close() {
    fs.closeSync(this.#fh)
  }

  private init(): Config {
    let buf = Buffer.alloc(768)
    fs.readSync(this.#fh, buf, 0, 768, 0)

    const headerParser = new Parser()
      .endianness('little')
      .uint16('version')
      .uint32('records')
      .uint16('blockSize')
      .array('referencePositions', {
        type: 'uint32le',
        length: 5,
      })
      .uint32('primaryKeyPosition')
      .array('secondaryKeyPositions', {
        type: 'uint32le',
        length: 3,
      })
      .string('tableName', { length: 20, stripNull: true })
      .uint8('primaryKeyItemCount')
      .array('primaryKeyItems', {
        type: Parser.start()
          .endianness('little')
          .string('name', { length: 20, stripNull: true })
          .uint8('dataType')
          .uint8('startPosition')
          .uint8('length'),
        length: 'primaryKeyItemCount',
      })
      .uint8('secondaryKeyItemCount')
      .array('secondaryKeyItems', {
        type: Parser.start()
          .endianness('little')
          .uint8('secondaryCount')
          .array('items', {
            type: Parser.start()
              .endianness('little')
              .string('name', { length: 20, stripNull: true })
              .uint8('dataType')
              .uint8('startPosition')
              .uint8('length'),
            length: 'secondaryCount',
          }),
        length: 'secondaryKeyItemCount',
      })
      .uint8('columnItemsCount')
      .array('columnItems', {
        type: Parser.start()
          .endianness('little')
          .string('name', { length: 20, stripNull: true })
          .uint8('dataType')
          .uint8('startPosition')
          .uint8('length'),
        length: 'columnItemsCount',
      })

    const config = headerParser.parse(buf) as Config
    config.primaryKeyLength = config.primaryKeyItems.reduce((acc, pk) => {
      return acc + pk.length
    }, 0)
    config.secondaryKeyLengths = config.secondaryKeyItems.map(k => {
      return k.items.reduce((acc, pk) => {
        return acc + pk.length
      }, 0)
    })

    let pos = 0
    let ref_index = 0
    const refs = []
    const ppos = []
    for (const columnItem of config.columnItems) {
      ppos.push(pos)
      pos = columnItem.dataType == 0 ? pos + 2 : pos + columnItem.length
      const ref = columnItem.dataType == 0 ? ref_index : -1
      ref_index = columnItem.dataType == 0 ? ref_index + 1 : ref_index
      refs.push(ref)
    }
    config.columnPackedPositions = ppos
    config.referenceIndex = refs

    config.referenceTables = config.referencePositions
      .filter(pos => pos > 0)
      .map(pos => {
        buf = Buffer.alloc(8)
        fs.readSync(this.#fh, buf, 0, 8, pos)

        const refItems = buf.readUint32LE(0)
        const itemWidth = buf.readUint32LE(4)

        buf = Buffer.alloc(refItems * itemWidth)
        fs.readSync(this.#fh, buf, 0, refItems * itemWidth, pos + 8)

        const refs: number[][] = []
        for (let i = 0; i < refItems; i++) {
          const subrefs: number[] = []
          for (let j = 0; j < itemWidth; j++) {
            subrefs.push(buf.readUint8(0 + i * itemWidth + j))
          }
          refs.push(subrefs)
        }

        return refs
      })

    config.referencePadding = config.columnItems.reduce((acc, item) => {
      return item.dataType == 0 ? acc + item.length - 2 : acc + 0
    }, 0)

    return config
  }

  public findByPrimaryKey(keyword: string, lineLength: number) {
    let buf = Buffer.alloc(4)
    fs.readSync(this.#fh, buf, 0, 4, this.config.primaryKeyPosition)
    const itemCount = buf.readUInt32LE()
    const keyBlockSize = this.config.primaryKeyLength + 8

    for (let i = 0; i < itemCount; i++) {
      buf = Buffer.alloc(keyBlockSize)
      fs.readSync(
        this.#fh,
        buf,
        0,
        keyBlockSize,
        this.config.primaryKeyPosition + 4 + i * keyBlockSize,
      )

      const key = buf.toString('ascii', 0, this.config.primaryKeyLength)
      const blockStart = buf.readUInt32LE(this.config.primaryKeyLength)
      const blockEnd = buf.readUInt32LE(this.config.primaryKeyLength + 4)

      if (this.compareKeys(keyword, key, this.config.primaryKeyLength) >= 0) {
        return this.readBlock('_PK', keyword, blockStart, blockEnd, lineLength)
      }
    }
    return null
  }

  public findBySecondaryKey(
    keyName: string,
    keyword: string,
    lineLength: number,
  ) {
    const secondayKeyIndex = this.config.secondaryKeyItems.findIndex(p => {
      if (p.items.find(k => k.name == keyName)) {
        return true
      } else {
        return false
      }
    })
    const keyPosition = this.config.secondaryKeyPositions[secondayKeyIndex]
    const keyLength = this.config.secondaryKeyLengths[secondayKeyIndex]

    let buf = Buffer.alloc(4)
    fs.readSync(this.#fh, buf, 0, 4, keyPosition)
    const itemCount = buf.readUInt32LE()
    const keyBlockSize = keyLength + 8

    for (let i = 0; i < itemCount; i++) {
      buf = Buffer.alloc(keyBlockSize)
      fs.readSync(
        this.#fh,
        buf,
        0,
        keyBlockSize,
        keyPosition + 4 + i * keyBlockSize,
      )

      const key = buf.toString('ascii', 0, keyLength)
      const blockStart = buf.readUInt32LE(keyLength)
      const blockEnd = buf.readUInt32LE(keyLength + 4)

      if (this.compareKeys(keyword, key, keyLength) >= 0) {
        const [pkBlockStart, pkBlockEnd] = this.parseIndex(
          keyword,
          blockStart,
          blockEnd,
          keyLength,
        )

        return this.readBlock(
          keyName,
          keyword,
          pkBlockStart,
          pkBlockEnd,
          lineLength,
        )
      }
    }
    return null
  }

  private parseIndex(
    keyword: string,
    blockStart: number,
    blockEnd: number,
    keyLength: number,
  ) {
    const blockSize = blockEnd - blockStart
    const buf = Buffer.alloc(blockSize)
    fs.readSync(this.#fh, buf, 0, blockSize, blockStart)

    const bzbuf = Bunzip.decode(buf)
    for (let pos = 0; pos < bzbuf.length; ) {
      const key = bzbuf.toString('ascii', pos, pos + keyLength)
      const index = bzbuf.readUInt16LE(keyLength + pos)

      if (this.compareKeys(keyword, key, keyLength) >= 0) {
        const position =
          this.config.primaryKeyPosition +
          4 +
          (this.config.primaryKeyLength + 8) * index

        const keyBuf = Buffer.alloc(this.config.primaryKeyLength + 8)
        fs.readSync(
          this.#fh,
          keyBuf,
          0,
          this.config.primaryKeyLength + 8,
          position,
        )

        // const pkey = keyBuf.toString('ascii', 0, this.config.primaryKeyLength)
        blockStart = keyBuf.readUInt32LE(this.config.primaryKeyLength)
        blockEnd = keyBuf.readUInt32LE(this.config.primaryKeyLength + 4)

        return [blockStart, blockEnd]
      }

      pos += keyLength + 2
    }
    return [0, 0]
  }

  private readBlock(
    keyName: string,
    keyword: string,
    blockStart: number,
    blockEnd: number,
    lineLength: number,
  ) {
    const blockSize = blockEnd - blockStart
    const buf = Buffer.alloc(blockSize)
    fs.readSync(this.#fh, buf, 0, blockSize, blockStart)

    const bzbuf = Bunzip.decode(buf)
    // const rows = []

    for (let bzpos = 0; bzpos < bzbuf.length; ) {
      let dataLength = bzbuf.readUInt8(bzpos)
      if (lineLength == 2) {
        dataLength = bzbuf.readUint16LE(bzpos)
      }
      const rowBuf = bzbuf.subarray(
        bzpos + lineLength,
        bzpos + lineLength + dataLength,
      )

      const row: { [k: string]: string } = { _PK: '' }

      const readSize = dataLength - lineLength
      for (const [
        columnIndex,
        columnItem,
      ] of this.config.columnItems.entries()) {
        if (columnItem.dataType == 0) {
          const referenceIndex = rowBuf.readUInt16LE(columnItem.startPosition)
          row[columnItem.name] = String.fromCharCode.apply(
            null,
            this.config.referenceTables[
              this.config.referenceIndex[columnIndex]
            ][referenceIndex],
          )
        } else {
          const length =
            columnItem.length == 0
              ? readSize +
                this.config.referencePadding -
                columnItem.startPosition
              : columnItem.length
          const colData = rowBuf.toString(
            'ascii',
            columnItem.startPosition - this.config.referencePadding,
            columnItem.startPosition + length - this.config.referencePadding,
          )
          row[columnItem.name] = colData
        }
      }

      // construct primary key and check
      const wholeRow = Object.values(row).join('')
      let pk = ''
      for (const pki of this.config.primaryKeyItems) {
        pk += wholeRow.slice(pki.startPosition, pki.startPosition + pki.length)
      }
      row['_PK'] = pk
      if (row[keyName] == keyword) return row

      // rows.push(row)
      bzpos += dataLength
    }

    return null
  }

  private compareKeys(k1: string, k2: string, keyLength: number) {
    if (k1.length < keyLength || k2.length < keyLength) {
      return -1
    }
    for (let i = 0; i < keyLength; i++) {
      if (k1[i] > k2[i]) {
        return -1
      }
      if (k1[i] < k2[i]) {
        return 1
      }
    }
    return 0
  }
}
