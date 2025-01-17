import { remote } from 'electron';
import { isArrayBuffer, isEmpty, isUndefined, omit } from 'lodash';
import {
  createAbsolutePathGetter,
  createDeleter,
  createReader,
  createWriterForNew,
  getPath,
} from '../attachments/attachments';
import {
  autoOrientJPEGAttachment,
  captureDimensionsAndScreenshot,
  deleteData,
  loadData,
  replaceUnicodeV2,
} from './attachments/migrations';

// tslint:disable: prefer-object-spread

// FIXME audric
// upgrade: exports._mapAttachments(autoOrientJPEGAttachment),
// upgrade: exports._mapAttachments(replaceUnicodeOrderOverrides),
// upgrade: _mapAttachments(migrateDataToFileSystem),
// upgrade: ._mapQuotedAttachments(migrateDataToFileSystem),
// upgrade: initializeAttachmentMetadata,
// upgrade: initializeAttachmentMetadata,
// upgrade: _mapAttachments(captureDimensionsAndScreenshot),
// upgrade: _mapAttachments(replaceUnicodeV2),
// upgrade: _mapPreviewAttachments(migrateDataToFileSystem),

export const deleteExternalMessageFiles = async (message: {
  attachments: any;
  quote: any;
  contact: any;
  preview: any;
}) => {
  const { attachments, quote, contact, preview } = message;

  if (attachments && attachments.length) {
    await Promise.all(attachments.map(deleteData));
  }

  if (quote && quote.attachments && quote.attachments.length) {
    await Promise.all(
      quote.attachments.map(async (attachment: { thumbnail: any }) => {
        const { thumbnail } = attachment;

        // To prevent spoofing, we copy the original image from the quoted message.
        //   If so, it will have a 'copied' field. We don't want to delete it if it has
        //   that field set to true.
        if (thumbnail && thumbnail.path && !thumbnail.copied) {
          await deleteOnDisk(thumbnail.path);
        }
      })
    );
  }

  if (contact && contact.length) {
    await Promise.all(
      contact.map(async (item: { avatar: any }) => {
        const { avatar } = item;

        if (avatar && avatar.avatar && avatar.avatar.path) {
          await deleteOnDisk(avatar.avatar.path);
        }
      })
    );
  }

  if (preview && preview.length) {
    await Promise.all(
      preview.map(async (item: { image: any }) => {
        const { image } = item;

        if (image && image.path) {
          await deleteOnDisk(image.path);
        }
      })
    );
  }
};

let attachmentsPath: string | undefined;

let internalReadAttachmentData: ((relativePath: string) => Promise<ArrayBufferLike>) | undefined;
let internalGetAbsoluteAttachmentPath: ((relativePath: string) => string) | undefined;
let internalDeleteOnDisk: ((relativePath: string) => Promise<void>) | undefined;
let internalWriteNewAttachmentData: ((arrayBuffer: ArrayBuffer) => Promise<string>) | undefined;

// userDataPath must be app.getPath('userData');
export function initializeAttachmentLogic() {
  const userDataPath = remote.app.getPath('userData');
  if (attachmentsPath) {
    throw new Error('attachmentsPath already initialized');
  }

  if (!userDataPath || userDataPath.length <= 10) {
    throw new Error('userDataPath cannot have length <= 10');
  }
  attachmentsPath = getPath(userDataPath);
  internalReadAttachmentData = createReader(attachmentsPath);
  internalGetAbsoluteAttachmentPath = createAbsolutePathGetter(attachmentsPath);
  internalDeleteOnDisk = createDeleter(attachmentsPath);
  internalWriteNewAttachmentData = createWriterForNew(attachmentsPath);
}

export const getAttachmentPath = () => {
  if (!attachmentsPath) {
    throw new Error('attachmentsPath not init');
  }
  return attachmentsPath;
};

export const loadAttachmentData = loadData;

export const loadPreviewData = async (preview: any): Promise<Array<any>> => {
  if (!preview || !preview.length || isEmpty(preview[0])) {
    return [];
  }

  const firstPreview = preview[0];
  if (!firstPreview.image) {
    return [firstPreview];
  }

  return [
    {
      ...firstPreview,
      image: await loadAttachmentData(firstPreview.image),
    },
  ];
};

export const loadQuoteData = async (quote: any) => {
  if (!quote) {
    return null;
  }
  if (!quote.attachments?.length || isEmpty(quote.attachments[0])) {
    return quote;
  }

  const quotedFirstAttachment = await quote.attachments[0];

  const { thumbnail } = quotedFirstAttachment;

  if (!thumbnail || !thumbnail.path) {
    return {
      ...quote,
      attachments: [quotedFirstAttachment],
    };
  }
  const quotedAttachmentWithThumbnail = {
    ...quotedFirstAttachment,
    thumbnail: await loadAttachmentData(thumbnail),
  };

  return {
    ...quote,
    attachments: [quotedAttachmentWithThumbnail],
  };
};

export const processNewAttachment = async (attachment: {
  fileName?: string;
  contentType: string;
  data: ArrayBuffer;
  digest?: string;
  path?: string;
  isRaw?: boolean;
}) => {
  const fileName = attachment.fileName ? replaceUnicodeV2(attachment.fileName) : '';
  // this operation might change the size (as we might print the content to a canvas and get the data back)
  const rotatedData = await autoOrientJPEGAttachment(attachment);

  const onDiskAttachmentPath = await migrateDataToFileSystem(rotatedData.data);

  const attachmentWithoutData = omit({ ...attachment, fileName, path: onDiskAttachmentPath }, [
    'data',
  ]);
  if (rotatedData.shouldDeleteDigest) {
    delete attachmentWithoutData.digest;
  }
  const finalAttachment = await captureDimensionsAndScreenshot(attachmentWithoutData);

  return { ...finalAttachment, fileName, size: rotatedData.data.byteLength };
};

export const readAttachmentData = async (relativePath: string): Promise<ArrayBufferLike> => {
  if (!internalReadAttachmentData) {
    throw new Error('attachment logic not initialized');
  }
  return internalReadAttachmentData(relativePath);
};

export const getAbsoluteAttachmentPath = (relativePath?: string): string => {
  if (!internalGetAbsoluteAttachmentPath) {
    throw new Error('attachment logic not initialized');
  }
  return internalGetAbsoluteAttachmentPath(relativePath || '');
};

export const deleteOnDisk = async (relativePath: string): Promise<void> => {
  if (!internalDeleteOnDisk) {
    throw new Error('attachment logic not initialized');
  }
  return internalDeleteOnDisk(relativePath);
};

export const writeNewAttachmentData = async (arrayBuffer: ArrayBuffer): Promise<string> => {
  if (!internalWriteNewAttachmentData) {
    throw new Error('attachment logic not initialized');
  }
  return internalWriteNewAttachmentData(arrayBuffer);
};

// type Context :: {
//   writeNewAttachmentData :: ArrayBuffer -> Promise (IO Path)
// }
//
//      migrateDataToFileSystem :: Attachment ->
//                                 Context ->
//                                 Promise Attachment
export const migrateDataToFileSystem = async (data?: ArrayBuffer) => {
  const hasDataField = !isUndefined(data);

  if (!hasDataField) {
    throw new Error('attachment has no data in migrateDataToFileSystem');
  }

  const isValidData = isArrayBuffer(data);
  if (!isValidData) {
    throw new TypeError(`Expected ${data} to be an array buffer got: ${typeof data}`);
  }

  const path = await writeNewAttachmentData(data);

  return path;
};

export async function deleteExternalFilesOfConversation(conversation: {
  avatar: any;
  profileAvatar: any;
}) {
  if (!conversation) {
    return;
  }

  const { avatar, profileAvatar } = conversation;

  if (avatar && avatar.path) {
    await deleteOnDisk(avatar.path);
  }

  if (profileAvatar && profileAvatar.path) {
    await deleteOnDisk(profileAvatar.path);
  }
}
