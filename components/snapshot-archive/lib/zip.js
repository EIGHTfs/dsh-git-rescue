/**
 * dsh-snapshot-archive — 零依赖 zip 工具
 *
 * Store 模式 ZIP 生成/解析，跨平台（Linux/macOS/Windows），不依赖 PowerShell
 * 或系统 zip 命令。实现 ZIP 规范：
 *   - Local File Header (LFH) + data
 *   - Central Directory (CD)
 *   - End of Central Directory (EOCD)
 * 压缩方法固定 0 (store)，与任何解压工具兼容（资源管理器 / unzip / Expand-Archive）。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC32 校验和。 */
export function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function u16(v) {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(v & 0xffff, 0)
  return b
}

function u32(v) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(v >>> 0, 0)
  return b
}

/**
 * 将一组文件打包成 store 模式 ZIP。
 * @param {{name: string, data: Buffer}[]} files - 文件条目，name 为 zip 内路径。
 * @returns {Buffer} zip 字节。
 */
export function zipStore(files) {
  const chunks = []
  const central = []
  let offset = 0

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8')
    const crc = crc32(f.data)
    const size = f.data.length
    const dosTime = 0 // 0 时间戳即可，跨平台兼容

    // Local File Header
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0) // signature
    lfh.writeUInt16LE(20, 4) // version needed
    lfh.writeUInt16LE(0x0800, 6) // flags: UTF-8 names
    lfh.writeUInt16LE(0, 8) // method: store
    lfh.writeUInt16LE(dosTime, 10) // mod time
    lfh.writeUInt16LE(dosTime, 12) // mod date
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(size, 18) // compressed size = size
    lfh.writeUInt32LE(size, 22) // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28) // extra len

    chunks.push(lfh, nameBuf, f.data)
    const localSize = 30 + nameBuf.length + size

    // Central Directory entry
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0) // signature
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(0x0800, 8) // flags
    cd.writeUInt16LE(0, 10) // method
    cd.writeUInt16LE(dosTime, 12)
    cd.writeUInt16LE(dosTime, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(size, 20)
    cd.writeUInt32LE(size, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30) // extra len
    cd.writeUInt16LE(0, 32) // comment len
    cd.writeUInt16LE(0, 34) // disk number
    cd.writeUInt16LE(0, 36) // internal attrs
    cd.writeUInt32LE(0, 38) // external attrs
    cd.writeUInt32LE(offset, 42) // local header offset

    central.push(cd, nameBuf)
    offset += localSize
  }

  // End of Central Directory
  const cdSize = central.reduce((a, b) => a + b.length, 0)
  const cdOffset = offset
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4) // disk number
  eocd.writeUInt16LE(0, 6) // cd start disk
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(cdOffset, 16)
  eocd.writeUInt16LE(0, 20) // comment len

  return Buffer.concat([...chunks, ...central, eocd])
}

/**
 * 解析 store 模式 ZIP，返回文件映射。
 * @param {Buffer} buf - zip 字节。
 * @returns {Map<string, Buffer>} name -> data。
 */
export function unzipStore(buf) {
  const out = new Map()
  // 从尾部找 EOCD（22 字节 + 可能的 comment）
  let eocdPos = -1
  const minLen = Math.min(buf.length, 22 + 65535)
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - minLen); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdPos = i; break }
  }
  if (eocdPos === -1) throw new Error('zip: EOCD not found')

  const totalEntries = buf.readUInt16LE(eocdPos + 10)
  let cdPos = buf.readUInt32LE(eocdPos + 16)

  for (let n = 0; n < totalEntries; n++) {
    if (buf.readUInt32LE(cdPos) !== 0x02014b50) throw new Error('zip: bad central dir entry')
    const method = buf.readUInt16LE(cdPos + 10)
    const compSize = buf.readUInt32LE(cdPos + 20)
    const nameLen = buf.readUInt16LE(cdPos + 28)
    const extraLen = buf.readUInt16LE(cdPos + 30)
    const commentLen = buf.readUInt16LE(cdPos + 32)
    const localOffset = buf.readUInt32LE(cdPos + 42)
    const name = buf.toString('utf8', cdPos + 46, cdPos + 46 + nameLen)
    if (!name.endsWith('/')) {
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`zip: bad local header for ${name}`)
      const lNameLen = buf.readUInt16LE(localOffset + 26)
      const lExtraLen = buf.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + lNameLen + lExtraLen
      let data
      if (method === 0) {
        data = buf.subarray(dataStart, dataStart + compSize)
      } else {
        throw new Error(`zip: unsupported method ${method} for ${name} (store only)`)
      }
      out.set(name, Buffer.from(data))
    }
    cdPos += 46 + nameLen + extraLen + commentLen
  }
  return out
}
