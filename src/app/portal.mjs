// 门户上报：post（对账行）/ credit（冲抵）/ inspect（回执查询）。
// 同一业务请求固定 key，重发拿到原回执；503 时保留本地待发，不丢凭据。
export class PortalBook {
  /** @param {HttpSource} source @param {JsonEventStore} store @param {string} phase */
  constructor(source, store, phase) {
    this.source = source;
    this.store = store;
    this.phase = phase;
  }

  static keyFor(action, businessId) {
    return `${action}:${businessId}`;
  }

  async postLine(line) {
    const key = PortalBook.keyFor('post', line.lineId);
    return this.#send('post', key, { lineId: line.lineId, wagon: line.wagon, fen: line.fen, period: line.period });
  }

  async postCredit(reversal) {
    const key = PortalBook.keyFor('credit', reversal.reversalId);
    return this.#send('credit', key, {
      reversalId: reversal.reversalId,
      originalLineId: reversal.originalLineId,
      reversalFen: reversal.reversalFen,
      netFen: reversal.netFen,
    });
  }

  async inspect(action, businessId) {
    const key = PortalBook.keyFor(action, businessId);
    return this.source.portal(this.phase, { action: 'inspect', key });
  }

  async #send(action, key, facts) {
    try {
      const res = await this.source.portal(this.phase, { action, key, facts });
      this.store.addPortalReceipt({ action, key, facts, status: res.status, receipt: res.receipt });
      await this.store.persist();
      return res;
    } catch (err) {
      if (err.code === 'PORTAL_UNAVAILABLE') {
        this.store.addPortalReceipt({ action, key, facts, status: 'queued-local', error: err.code });
        await this.store.persist();
        return { status: 'queued-local', duplicate: false, receipt: null };
      }
      throw err;
    }
  }
}
