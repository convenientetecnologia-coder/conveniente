'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyPublishRequest,
  acceptExit,
  isPublishMarked,
  isPhotoUploadUrl,
  bodyHasImage,
  composerPhotoProblem,
  judgePhotoResponse
} = require('./mobilePublishProxy.js');

test('AS22085 no Brasil entra, outra rede nao entra', () => {
  assert.equal(acceptExit({ asn: 'AS22085', country: 'BR' }), true);
  assert.equal(acceptExit({ asn: 'AS28573', country: 'BR' }), false);
  assert.equal(acceptExit({ asn: 'AS22085', country: 'US' }), false);
  assert.equal(acceptExit({ asn: '', country: 'BR' }), false);
});

test('no botao publicar o anuncio vai no proxy, e a pagina de vendas volta pro wifi', () => {
  assert.equal(classifyPublishRequest({
    method: 'GET',
    url: 'https://www.facebook.com/marketplace/create/item',
    postData: ''
  }), 'wifi');
  assert.equal(classifyPublishRequest({
    method: 'POST',
    url: 'https://www.facebook.com/api/graphql/',
    postData: 'fb_api_req_friendly_name=CometMarketplaceListingCreateMutation&variables=%7B%7D'
  }), 'proxy');
  assert.equal(classifyPublishRequest({
    method: 'POST',
    url: 'https://www.facebook.com/api/graphql/',
    postData: 'fb_api_req_friendly_name=MarketplaceYouSellingQuery&doc_id=1',
    publishCaptured: true
  }), 'wifi');
  assert.equal(classifyPublishRequest({
    method: 'GET',
    url: 'https://www.facebook.com/marketplace/you/selling',
    postData: ''
  }), 'wifi');
  assert.equal(isPublishMarked({
    postData: 'fb_api_req_friendly_name=CometMarketplaceListingCreateMutation'
  }), true);
});

test('foto recusada pelo Facebook segura o anuncio', () => {
  assert.equal(composerPhotoProblem('Não foi possível processar a foto'), 'photo_process_failed');
  assert.equal(composerPhotoProblem('Item para venda\nJorge Matos'), '');
  assert.equal(isPhotoUploadUrl('https://upload.facebook.com/ajax/react_composer/attachments/photo/upload'), true);
  assert.equal(isPhotoUploadUrl('https://www.facebook.com/api/graphql/'), false);
  assert.equal(judgePhotoResponse(200, Buffer.from('{"payload":{"photoID":"1"}}')).ok, true);
  assert.equal(judgePhotoResponse(200, 'Não foi possível processar a foto').ok, false);
  assert.equal(judgePhotoResponse(0, Buffer.alloc(0)).reason, 'photo_upload_no_status');
  assert.equal(bodyHasImage(Buffer.from([0xFF, 0xD8, 0xFF, 0xD9])), true);
  assert.equal(bodyHasImage(Buffer.from('texto sem imagem')), false);
  assert.equal(judgePhotoResponse(200, 'Sua solicitação não pôde ser processada').ok, false);
});

test('a foto do disco entra no formulario quando o navegador manda o corpo vazio', () => {
  const { splicePhotoFile, bodyHasImage, multipartFieldNames } = require('./mobilePublishProxy.js');
  const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0x11, 0x22, 0x33]), Buffer.alloc(120, 7)]);
  const shell = Buffer.from(
    '--B\r\nContent-Disposition: form-data; name="fb_dtsg"\r\n\r\nTOKEN\r\n' +
    '--B\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n' +
    '\r\n--B--\r\n'
  );
  const out = splicePhotoFile(shell, 'multipart/form-data; boundary=B', jpeg);
  assert.equal(bodyHasImage(out), true);
  assert.equal(out.includes(Buffer.from('TOKEN')), true);
  assert.equal(out.includes(jpeg), true);
  assert.equal(multipartFieldNames(shell), 'fb_dtsg,file:file');
  const noFile = Buffer.from(
    '--B\r\nContent-Disposition: form-data; name="source"\r\n\r\n8\r\n--B--\r\n'
  );
  const added = splicePhotoFile(noFile, 'multipart/form-data; boundary=B', jpeg);
  assert.equal(bodyHasImage(added), true);
  assert.equal(added.includes(Buffer.from('name="source"')), true);
  assert.equal(added.includes(jpeg), true);
});
